'use client';

import React, { useState } from 'react';
import { useAuth } from '../../lib/auth/auth-context';
import { useProgression } from '../../lib/query/hooks';
import { MessageSquare, Star, Heart, ThumbsUp, Send, User, Sparkles } from 'lucide-react';
import { Button } from '../ui/button';

interface CommentItem {
  id: string;
  username: string;
  userRole?: string;
  userLevel?: number;
  rankTitle?: string;
  content: string;
  rating?: number;
  likesCount: number;
  isLiked?: boolean;
  createdAt: string;
}

interface StoryCommentSectionProps {
  storySlug: string;
  initialRating?: number;
}

export function StoryCommentSection({ storySlug, initialRating = 4.8 }: StoryCommentSectionProps) {
  const { user } = useAuth();
  const { data: progression } = useProgression();
  const [commentText, setCommentText] = useState('');
  const [selectedRating, setSelectedRating] = useState(5);
  const [hoverRating, setHoverRating] = useState(0);

  // Mock comments state for interactive demonstration
  const [comments, setComments] = useState<CommentItem[]>([
    {
      id: 'c-1',
      username: 'MangaMaster99',
      userLevel: 7,
      rankTitle: 'Đại Tông Sư Đọc Truyện',
      content: 'Bộ này siêu phẩm! Bản dịch AI Studio đọc mượt như người dịch chuyên nghiệp, typeset canh bong bóng thoại chuẩn đét!',
      rating: 5,
      likesCount: 24,
      isLiked: false,
      createdAt: '2 giờ trước',
    },
    {
      id: 'c-2',
      username: 'NovelEnthusiast',
      userLevel: 4,
      rankTitle: 'Độc Giả Tinh Anh',
      content: 'Light novel đọc trên theme Sepia cực kỳ dịu mắt. Mong nhóm ra chương mới nhanh nhanh!',
      rating: 5,
      likesCount: 12,
      isLiked: false,
      createdAt: '5 giờ trước',
    },
  ]);

  const handleSubmitComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (!commentText.trim()) return;

    const newComment: CommentItem = {
      id: `c-${Date.now()}`,
      username: user.username,
      userLevel: progression?.level || 1,
      rankTitle: progression?.rankTitle || 'Tân Thủ Độc Giả',
      content: commentText.trim(),
      rating: selectedRating,
      likesCount: 0,
      isLiked: false,
      createdAt: 'Vừa xong',
    };

    setComments([newComment, ...comments]);
    setCommentText('');
  };

  const handleLikeComment = (commentId: string) => {
    setComments((prev) =>
      prev.map((c) => {
        if (c.id === commentId) {
          const nextLiked = !c.isLiked;
          return {
            ...c,
            isLiked: nextLiked,
            likesCount: nextLiked ? c.likesCount + 1 : c.likesCount - 1,
          };
        }
        return c;
      })
    );
  };

  return (
    <div className="bg-slate-900/60 border border-slate-800/80 rounded-3xl p-5 sm:p-7 shadow-xl space-y-6">
      {/* Header & Rating Overview */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
            <MessageSquare className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-extrabold text-lg text-white">Bình Luận & Đánh Giá</h3>
            <p className="text-xs text-slate-400">
              <span className="text-white font-bold">{comments.length}</span> lượt thảo luận từ cộng đồng độc giả
            </p>
          </div>
        </div>

        {/* Rating Score Card */}
        <div className="flex items-center gap-3 bg-slate-950/80 border border-slate-800 px-4 py-2 rounded-2xl">
          <div className="flex items-center gap-1 text-amber-400">
            <Star className="w-5 h-5 fill-amber-400 text-amber-400" />
            <span className="text-lg font-black">{initialRating.toFixed(1)}</span>
          </div>
          <div className="h-6 w-px bg-slate-800" />
          <span className="text-xs text-slate-400">Đánh giá chung (5★)</span>
        </div>
      </div>

      {/* Post Comment & Rating Box */}
      <form onSubmit={handleSubmitComment} className="space-y-3 bg-slate-950/70 border border-slate-800 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-2">
          {/* User Status / Level info */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-red-600/20 text-red-400 flex items-center justify-center text-xs font-bold">
              {user ? (user.username?.charAt(0) || 'U').toUpperCase() : <User className="w-3.5 h-3.5" />}
            </div>
            {user ? (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-bold text-white">{user.username}</span>
                {progression && (
                  <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-extrabold">
                    Lv.{progression.level}
                  </span>
                )}
              </div>
            ) : (
              <span className="text-xs text-slate-400">Bình luận ẩn danh (yêu cầu đăng nhập để gửi)</span>
            )}
          </div>

          {/* Star Rating selector */}
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-slate-400 mr-1 hidden sm:inline">Chấm điểm:</span>
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setSelectedRating(star)}
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(0)}
                aria-label={`Chấm ${star} sao`}
                className="p-0.5 transition-transform hover:scale-110"
              >
                <Star
                  className={`w-4 h-4 ${
                    star <= (hoverRating || selectedRating)
                      ? 'fill-amber-400 text-amber-400'
                      : 'text-slate-600'
                  }`}
                />
              </button>
            ))}
          </div>
        </div>

        {/* Text Area Input */}
        <textarea
          rows={3}
          placeholder={
            user
              ? 'Chia sẻ cảm nghĩ của bạn về bộ truyện này...'
              : 'Đăng nhập để chia sẻ cảm nghĩ và nhận EXP độc giả...'
          }
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-red-500 transition-colors resize-none"
        />

        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="gap-1.5 shadow-md"
            disabled={!commentText.trim()}
          >
            <Send className="w-3.5 h-3.5" />
            Gửi Bình Luận
          </Button>
        </div>
      </form>

      {/* Comments List */}
      <div className="space-y-3 pt-2">
        {comments.map((comment) => (
          <div
            key={comment.id}
            className="p-4 rounded-2xl bg-slate-950/40 border border-slate-800/80 space-y-2 hover:border-slate-700 transition-colors"
          >
            {/* Author info & Rating stars */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 flex items-center justify-center text-xs font-bold">
                  {comment.username.charAt(0).toUpperCase()}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-bold text-xs text-white">{comment.username}</span>
                  {comment.userLevel && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-extrabold">
                      Lv.{comment.userLevel}
                    </span>
                  )}
                  {comment.rankTitle && (
                    <span className="text-[10px] text-slate-400 hidden sm:inline">
                      • {comment.rankTitle}
                    </span>
                  )}
                </div>
              </div>

              {/* Star rating */}
              {comment.rating && (
                <div className="flex items-center gap-0.5 text-amber-400">
                  {Array.from({ length: comment.rating }).map((_, i) => (
                    <Star key={i} className="w-3 h-3 fill-amber-400 text-amber-400" />
                  ))}
                </div>
              )}
            </div>

            {/* Comment Body */}
            <p className="text-xs text-slate-300 leading-relaxed pl-9">{comment.content}</p>

            {/* Footnote Actions */}
            <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 pl-9">
              <span>{comment.createdAt}</span>

              <button
                onClick={() => handleLikeComment(comment.id)}
                className={`flex items-center gap-1 transition-colors px-2 py-0.5 rounded-md ${
                  comment.isLiked
                    ? 'text-red-400 bg-red-500/10'
                    : 'hover:text-white hover:bg-slate-900'
                }`}
              >
                <ThumbsUp className="w-3 h-3" />
                <span>{comment.likesCount > 0 ? comment.likesCount : 'Thích'}</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
