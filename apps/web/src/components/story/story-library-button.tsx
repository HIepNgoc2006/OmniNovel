'use client';

import React, { useState, useEffect } from 'react';
import { Bookmark } from 'lucide-react';
import { Button } from '../ui/button';
import { activeScopeCoordinator } from '../../lib/identity/active-scope-coordinator';
import { guestLibraryRepository } from '../../lib/storage/guest-library-repository';
import { setBookmarkApi, getBookmarkStatusApi } from '../../lib/api/stories';

export interface StoryLibraryButtonProps {
  storyId: string;
  storyTitle: string;
  storySlug: string;
  storyCoverUrl?: string;
  initialIsBookmarked?: boolean;
  onFollowersCountChange?: (count: number) => void;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function StoryLibraryButton({
  storyId,
  storyTitle,
  storySlug,
  storyCoverUrl,
  initialIsBookmarked,
  onFollowersCountChange,
  className,
  size = 'lg',
}: StoryLibraryButtonProps) {
  const [isBookmarked, setIsBookmarked] = useState<boolean>(initialIsBookmarked ?? false);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    activeScopeCoordinator.waitForResolvedScope().then(async (scope) => {
      if (!isMounted) return;
      if (scope.startsWith('guest:')) {
        const item = await guestLibraryRepository.getBookmark(storyId);
        if (isMounted) {
          setIsBookmarked(!!item);
        }
      } else if (scope.startsWith('account:')) {
        if (initialIsBookmarked === undefined) {
          try {
            const res = await getBookmarkStatusApi(storyId);
            if (isMounted) {
              setIsBookmarked(res.isBookmarked);
              if (typeof res.followersCount === 'number') {
                onFollowersCountChange?.(res.followersCount);
              }
            }
          } catch {
            // Fail-closed gracefully
          }
        }
      }
    });

    return () => {
      isMounted = false;
    };
  }, [storyId, initialIsBookmarked, onFollowersCountChange]);

  const handleToggle = async () => {
    if (isLoading) return;
    setIsLoading(true);

    try {
      const scope = await activeScopeCoordinator.waitForResolvedScope();
      if (scope.startsWith('guest:')) {
        if (isBookmarked) {
          await guestLibraryRepository.removeBookmark(storyId);
          setIsBookmarked(false);
        } else {
          await guestLibraryRepository.saveBookmark({
            storyId,
            title: storyTitle,
            slug: storySlug,
            coverUrl: storyCoverUrl,
            createdAt: new Date().toISOString(),
          });
          setIsBookmarked(true);
        }
      } else if (scope.startsWith('account:')) {
        const nextState = !isBookmarked;
        const res = await setBookmarkApi({ storyId, isBookmarked: nextState });
        setIsBookmarked(res.isBookmarked);
        if (typeof res.followersCount === 'number') {
          onFollowersCountChange?.(res.followersCount);
        }
      }
    } catch {
      // Safe error handling
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      variant={isBookmarked ? 'secondary' : 'outline'}
      size={size}
      onClick={handleToggle}
      isLoading={isLoading}
      className={`gap-2 ${
        isBookmarked
          ? 'text-amber-400 border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20'
          : 'text-slate-200'
      } ${className || ''}`}
      title={isBookmarked ? 'Xóa khỏi thư viện' : 'Lưu vào thư viện'}
    >
      <Bookmark
        className={`w-4 h-4 transition-transform active:scale-125 ${
          isBookmarked ? 'fill-amber-400 text-amber-400' : 'text-slate-400'
        }`}
      />
      <span>{isBookmarked ? 'Đã Lưu Vào Thư Viện' : 'Lưu Vào Thư Viện'}</span>
    </Button>
  );
}
