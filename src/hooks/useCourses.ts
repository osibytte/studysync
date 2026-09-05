import { useCallback, useEffect, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import { supabase } from '@/lib/supabase';
import type { Course } from '@/types/database';

/**
 * Course reference data.
 *
 * Cache-first with a background refresh: the list is seeded server-side and
 * changes at most once a semester, so serving it from cache is nearly always
 * correct and saves a round trip on a connection that may not have one to
 * spare. The refresh keeps a new semester's courses from requiring a reinstall.
 */

interface CoursesState {
  courses: Course[];
  loading: boolean;
  /** Set only when there is nothing to show — a stale-cache hit is not an error. */
  error: string | null;
  /** True when the list came from cache and the network fetch has not landed. */
  fromCache: boolean;
  reload: () => Promise<void>;
}

export function useCourses(): CoursesState {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  const load = useCallback(async () => {
    setError(null);

    const cached = await cacheReadData<Course[]>(CacheKeys.courses());
    if (cached && cached.length > 0) {
      setCourses(cached);
      setFromCache(true);
      setLoading(false);
    }

    const { data, error: fetchError } = await supabase
      .from('courses')
      .select('*')
      .order('course_code');

    if (fetchError) {
      // Only surface an error if the cache gave us nothing — otherwise the
      // student has a usable list and does not need to know the refresh failed.
      if (!cached || cached.length === 0) {
        setError("Can't load courses. Check your connection and pull to retry.");
      }
      setLoading(false);
      return;
    }

    const fresh = (data ?? []) as Course[];
    setCourses(fresh);
    setFromCache(false);
    setLoading(false);
    await cacheWrite(CacheKeys.courses(), fresh);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { courses, loading, error, fromCache, reload: load };
}
