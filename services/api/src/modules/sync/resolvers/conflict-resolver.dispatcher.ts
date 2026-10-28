import { Injectable } from '@nestjs/common';
import { SyncDomain } from '../interfaces/sync.types';
import {
  ConflictResolutionResult,
  ConflictResolverContext,
  IConflictResolver,
} from './conflict-resolver.interface';
import { BookmarkConflictResolver } from './bookmark.resolver';
import { ProgressConflictResolver } from './progress.resolver';
import { HistoryConflictResolver } from './history.resolver';
import { PreferenceConflictResolver } from './preference.resolver';
import { FollowConflictResolver } from './follow.resolver';

@Injectable()
export class ConflictResolverDispatcher {
  private readonly resolvers = new Map<SyncDomain, IConflictResolver>();

  constructor(
    bookmarkResolver: BookmarkConflictResolver,
    progressResolver: ProgressConflictResolver,
    historyResolver: HistoryConflictResolver,
    preferenceResolver: PreferenceConflictResolver,
    followResolver: FollowConflictResolver,
  ) {
    this.resolvers.set(SyncDomain.BOOKMARK, bookmarkResolver);
    this.resolvers.set(SyncDomain.PROGRESS, progressResolver);
    this.resolvers.set(SyncDomain.HISTORY, historyResolver);
    this.resolvers.set(SyncDomain.PREFERENCE, preferenceResolver);
    this.resolvers.set(SyncDomain.FOLLOW, followResolver);
  }

  async resolve(
    context: ConflictResolverContext,
  ): Promise<ConflictResolutionResult> {
    const resolver = this.resolvers.get(context.mutation.domain);

    if (!resolver) {
      return {
        status: 'DOMAIN_NOT_SUPPORTED',
        reason: 'UNRECOGNIZED_DOMAIN',
        message: `Domain '${context.mutation.domain}' is not recognized or supported by the sync engine`,
        assignedRevision: null,
      };
    }

    return resolver.resolve(context);
  }
}
