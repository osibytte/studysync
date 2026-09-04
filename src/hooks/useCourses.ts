import { useCallback, useEffect, useState } from 'react';
import { CacheKeys, cacheReadData, cacheWrite } from '@/lib/cache';
import { supabase } from '@/lib/supabase';
import type { Course, Topic } from '@/types/database';

/**
 * Course and topic reference data.
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

interface TopicsState {
  topics: Topic[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** Topics for one course. Same cache-first pattern, keyed per course. */
export function useTopics(courseId: string | null): TopicsState {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!courseId) {
      setTopics([]);
      setLoading(false);
      return;
    }
    setError(null);

    const cached = await cacheReadData<Topic[]>(CacheKeys.topics(courseId));
    if (cached && cached.length > 0) {
      setTopics(cached);
      setLoading(false);
    }

    const { data, error: fetchError } = await supabase
      .from('topics')
      .select('*')
      .eq('course_id', courseId)
      .order('sort_order');

    if (fetchError) {
      if (!cached || cached.length === 0) {
        setError("Can't load topics for this course.");
      }
      setLoading(false);
      return;
    }

    const fresh = (data ?? []) as Topic[];
    setTopics(fresh);
    setLoading(false);
    await cacheWrite(CacheKeys.topics(courseId), fresh);
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { topics, loading, error, reload: load };
}
