'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {FileEvent, FileNotifier} from '../../nuclide-open-files-rpc/lib/rpc-types';
import type {NuclideUri} from '../../commons-node/nuclideUri';
import type {NotifiersByConnection} from './NotifiersByConnection';

import invariant from 'assert';
import {CompositeDisposable} from 'atom';
import {getLogger} from '../../nuclide-logging';
import {convertRange} from '../../nuclide-open-files-common';

const logger = getLogger();

const RESYNC_TIMEOUT_MS = 2000;

// Watches a TextBuffer for change/rename/destroy events and then sends
// those events to the FileNotifier or NotifiersByConnection as appropriate.
//
// change/rename events go to the FileNotifier.
// If sending a change/rename throws, that is an indication that we are out of
// sync with the server side, so send a 'sync' message.
//
// close events have a different error recovery policy so they go to the main
// NotifiersByConnection. The close message must be sent even if the buffer is
// renamed or destroyed, so rather than keep the per-buffer info around after
// a buffer is destroyed, the outstanding close messages are kept with the
// per-connection info in NotifiersByConnection.
export class BufferSubscription {
  _oldPath: ?NuclideUri;
  _notifiers: NotifiersByConnection;
  _buffer: atom$TextBuffer;
  _notifier: ?Promise<FileNotifier>;
  _subscriptions: CompositeDisposable;
  _serverVersion: number;
  _lastAttemptedSync: number;

  constructor(notifiers: NotifiersByConnection, buffer: atom$TextBuffer) {
    this._notifiers = notifiers;
    this._buffer = buffer;
    this._notifier = null;
    this._serverVersion = -1;
    this._lastAttemptedSync = -1;

    const subscriptions = new CompositeDisposable();

    subscriptions.add(buffer.onDidChange(async (event: atom$TextEditEvent) => {
      if (this._notifier == null) {
        return;
      }
      // Must inspect the buffer before awaiting on the notifier
      // to avoid race conditions
      const filePath = this._buffer.getPath();
      invariant(filePath != null);
      const version = this._buffer.changeCount;
      const oldRange = convertRange(event.oldRange);
      const newRange = convertRange(event.newRange);
      const oldText = event.oldText;
      const newText = event.newText;

      invariant(this._notifier != null);
      const notifier = await this._notifier;
      this.sendEvent({
        kind: 'edit',
        fileVersion: {
          notifier,
          filePath,
          version,
        },
        oldRange,
        newRange,
        oldText,
        newText,
      });
    }));
    subscriptions.add(buffer.onDidChangePath(() => {
      this.sendClose();
      this.onChangePath();
    }));
    subscriptions.add(buffer.onDidDestroy(() => {
      this.sendClose();
      this.dispose();
    }));

    this._subscriptions = subscriptions;

    this.onChangePath();
  }

  onChangePath(): void {
    this._oldPath = this._buffer.getPath();
    this._notifier = this._notifiers.get(this._buffer);
    this.sendOpen();
  }

  async sendEvent(event: FileEvent) {
    invariant(event.kind !== 'sync');
    try {
      await event.fileVersion.notifier.onEvent(event);
      this.updateServerVersion(event.fileVersion.version);
    } catch (e) {
      logger.error(`Error sending file event: ${JSON.stringify(event)}`, e);

      if (event.fileVersion.filePath === this._buffer.getPath()) {
        logger.error('Attempting file resync');
        this.attemptResync();
      } else {
        logger.error('File renamed, so no resync attempted');
      }
    }
  }

  updateServerVersion(sentVersion: number): void {
    this._serverVersion = Math.max(this._serverVersion, sentVersion);
    this._lastAttemptedSync = Math.max(this._lastAttemptedSync, sentVersion);
  }

  // Something went awry in our synchronization protocol
  // Attempt a reset with a 'sync' event.
  attemptResync() {
    // always attempt to resync to the latest version
    const resyncVersion = this._buffer.changeCount;
    const filePath = this._buffer.getPath();

    // don't send a resync if another edit has already succeeded at this version
    // or an attempt to sync at this version is already underway
    if (resyncVersion > this._lastAttemptedSync) {
      logger.error('At most recent edit, attempting file resync');
      this._lastAttemptedSync = resyncVersion;

      const sendResync = async () => {
        if (this._notifier == null) {
          logger.error('Resync preempted by remote connection closed');
          return;
        }
        invariant(filePath != null);
        const notifier = await this._notifier;
        if (this._buffer.isDestroyed()) {
          logger.error('Resync preempted by later event');
        } else if (filePath !== this._buffer.getPath()) {
          logger.error('Resync preempted by file rename');
        } else if (resyncVersion !== this._lastAttemptedSync) {
          logger.error('Resync preempted by later resync');
        } else if (resyncVersion !== this._buffer.changeCount) {
          logger.error('Resync preempted by later edit');
        } else {
          const syncEvent = {
            kind: 'sync',
            fileVersion: {
              notifier,
              filePath,
              version: resyncVersion,
            },
            contents: this._buffer.getText(),
          };
          try {
            await notifier.onEvent(syncEvent);
            this.updateServerVersion(resyncVersion);

            logger.error(`Successful resync event: ${JSON.stringify(syncEvent)}`);
          } catch (syncError) {
            logger.error(
              `Error sending file sync event: ${JSON.stringify(syncEvent)}`,
              syncError);

            // continue trying until either the file is closed,
            // or a resync to a later edit is attempted
            // or the resync succeeds
            setTimeout(sendResync, RESYNC_TIMEOUT_MS);
          }
        }
      };

      sendResync();
    } else {
      logger.error('Resync aborted by more recent edit');
    }
  }

  async sendOpen(): Promise<void> {
    if (this._notifier == null) {
      return;
    }

    // Must inspect the buffer before awaiting on the notifier
    // to avoid race conditions
    const filePath = this._buffer.getPath();
    invariant(filePath != null);
    const version = this._buffer.changeCount;
    const contents = this._buffer.getText();

    invariant(this._notifier != null);
    const notifier = await this._notifier;
    this.sendEvent({
      kind: 'open',
      fileVersion: {
        notifier,
        filePath,
        version,
      },
      contents,
    });
  }

  sendClose() {
    // Use different retry policy for close messages.
    if (this._oldPath != null) {
      this._notifiers.sendClose(this._oldPath, this._buffer.changeCount);
    }
  }

  dispose() {
    this._notifier = null;
    this._subscriptions.dispose();
  }
}
