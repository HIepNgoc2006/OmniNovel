'use client';

import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { CreateJobForm } from '@/components/studio/job-creation/create-job-form';
import { Loader2 } from 'lucide-react';

function CreateJobPageContent() {
  const searchParams = useSearchParams();
  const storySlug = searchParams.get('storySlug') || undefined;
  const chapterId = searchParams.get('chapterId') || undefined;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <CreateJobForm
        initialStorySlug={storySlug}
        initialChapterId={chapterId}
      />
    </div>
  );
}

export default function CreateJobPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
        </div>
      }
    >
      <CreateJobPageContent />
    </Suspense>
  );
}
