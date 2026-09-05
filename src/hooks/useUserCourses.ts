import { useCallback, useEffect, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import { supabase } from '@/lib/supabase';
import type { UserCourseWithDetail } from '@/types/database';

/**
 * The signed-in student's enrolments, with course details.
 *
 * One query with a nested select rather than two round trips. On a slow
 * connection each additional request is a separate chance to fail, and this
 * screen needs both pieces before it can render anything useful.
 *
 * Cache-first for the same reason as useCourses, but more important here: this
 * is the student's own data, and it must be visible offline.
 */

interface State {
  userCourses: UserCourseWithDetail[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Patch local state without a refetch — for optimistic updates. */
  setLocal: (next: UserCourseWithDetail[]) => void;
}

export function useUserCourses(userId: string | null): State {
  const [userCourses, setUserCourses] = useState<UserCourseWithDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setUserCourses([]);
      setLoading(false);
      return;
    }
    setError(null);

    const cached = await cacheReadData<UserCourseWithDetail[]>(
      CacheKeys.userCourses(userId)
    );
    if (cached) {
      setUserCourses(cached);
      setLoading(false);
    }

    const { data, error: fetchError } = await supabase
      .from('user_courses')
      .select(
        `
        user_course_id,
        user_id,
        course_id,
        availability,
        matching_pref,
        created_at,
        course:courses (
          course_id,
          course_code,
          course_title,
          department,
          created_at
        )
      `
      )
      .eq('user_id', userId);

    if (fetchError) {
      if (!cached) {
        setError("Can't load your courses right now.");
      }
      setLoading(false);
      return;
    }

    // Flatten the nested join into the shape the UI wants.
    const shaped: UserCourseWithDetail[] = (data ?? []).map((row: any) => ({
      user_course_id: row.user_course_id,
      user_id: row.user_id,
      course_id: row.course_id,
      availability: row.availability,
      // Older cached rows predate 0007; fall back to the column's own default.
      matching_pref: row.matching_pref ?? 'system',
      created_at: row.created_at,
      course: row.course,
    }));

    // Sort client-side: ordering by a joined column in PostgREST is awkward,
    // and this list is never more than a handful of rows.
    shaped.sort((a, b) =>
      (a.course?.course_code ?? '').localeCompare(b.course?.course_code ?? '')
    );

    setUserCourses(shaped);
    setLoading(false);
    await cacheWrite(CacheKeys.userCourses(userId), shaped);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setLocal = useCallback(
    (next: UserCourseWithDetail[]) => {
      setUserCourses(next);
      if (userId) void cacheWrite(CacheKeys.userCourses(userId), next);
    },
    [userId]
  );

  return { userCourses, loading, error, reload: load, setLocal };
}
