import type { AppState } from '../src/types';

export interface WebDavSyncDocument {
  version: 1;
  updatedAt: number;
  following: AppState['following'];
  tasks: AppState['tasks'];
  followingDeletedAt: Record<string, number>;
}

export function documentFromState(state: AppState): WebDavSyncDocument;
export function documentsEqual(left: unknown, right: unknown): boolean;
export function ensureSyncMetadata(state: AppState): AppState['syncMetadata'];
export function markFollowingChanged(state: AppState, animeId: number, timestamp?: number): void;
export function markFollowingDeleted(state: AppState, animeId: number, timestamp?: number): void;
export function markTaskChanged(state: AppState, taskId: string, timestamp?: number): void;
export function mergeDocumentIntoState(state: AppState, remote: unknown): {
  changed: boolean;
  document: WebDavSyncDocument;
  remoteChanged: boolean;
};
export function normalizeDocument(value: unknown): WebDavSyncDocument;
