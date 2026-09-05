import {
  JOINABLE_STATUSES,
  MATCHING_PREF_HINT,
  MATCHING_PREF_LABEL,
  STATUS_HINT,
  STATUS_LABEL,
  canInvite,
  canRequestToJoin,
  capacityLabel,
  defaultGroupName,
  displayName,
  inMatchingPool,
  isCreator,
  isFull,
  isJoinable,
  isLive,
  meetRuleLabel,
  memberLine,
  requiresEveryone,
  scorePercent,
  seatsLeft,
  sortMyGroups,
} from '../groupRules';
import type {
  GroupMemberDetailRow,
  GroupStatus,
  MatchingPref,
  MyGroupRow,
} from '@/types/database';

/**
 * These rules are duplicated on purpose — the same conditions live in the
 * Stage 2 RPCs, which are the real enforcement. The tests here pin the client
 * copy so the two cannot drift silently: if a rule changes in SQL, one of these
 * should be the thing that notices.
 */

/** Every stored status, so adding a sixth to the enum breaks these tests. */
const ALL_STATUSES: GroupStatus[] = [
  'forming',
  'active',
  'dormant',
  'archived',
  'disbanded',
];

function member(over: Partial<GroupMemberDetailRow> = {}): GroupMemberDetailRow {
  return {
    user_id: 'u1',
    full_name: 'Adebayo Okonkwo',
    department: 'Computer Science',
    role: 'member',
    joined_at: '2026-09-01T10:00:00Z',
    ...over,
  };
}

function myGroup(over: Partial<MyGroupRow> = {}): MyGroupRow {
  return {
    group_id: 'g1',
    group_name: 'CSC 201 Study Group',
    course_id: 'c1',
    formation_type: 'self_organized',
    status: 'active',
    is_discoverable: true,
    max_members: 8,
    created_by: 'u1',
    last_activity_at: '2026-09-01T10:00:00Z',
    created_at: '2026-08-01T10:00:00Z',
    role: 'member',
    joined_at: '2026-08-01T10:00:00Z',
    member_count: 3,
    course: null,
    ...over,
  };
}

describe('status vocabulary', () => {
  it('has a label and a hint for every stored status', () => {
    // A missing entry renders as `undefined` in the UI rather than throwing,
    // which is exactly the kind of bug that ships.
    for (const status of ALL_STATUSES) {
      expect(STATUS_LABEL[status]).toBeTruthy();
      expect(STATUS_HINT[status]).toBeTruthy();
    }
  });

  it('treats forming, active and dormant as joinable', () => {
    expect([...JOINABLE_STATUSES]).toEqual(['forming', 'active', 'dormant']);
    expect(isJoinable('forming')).toBe(true);
    expect(isJoinable('active')).toBe(true);
    // Dormant is joinable on purpose: joining is one of the things that revives
    // a quiet group, so locking it would make dormancy self-reinforcing.
    expect(isJoinable('dormant')).toBe(true);
    expect(isJoinable('archived')).toBe(false);
    expect(isJoinable('disbanded')).toBe(false);
  });

  it('separates live from closed', () => {
    expect(isLive('forming')).toBe(true);
    expect(isLive('active')).toBe(true);
    expect(isLive('dormant')).toBe(true);
    expect(isLive('archived')).toBe(false);
    expect(isLive('disbanded')).toBe(false);
  });
});

describe('capacity', () => {
  it('phrases capacity the same way everywhere', () => {
    expect(capacityLabel(3, 8)).toBe('3 of 8 members');
    expect(capacityLabel(1, 1)).toBe('1 of 1 member');
  });

  it('counts free seats', () => {
    expect(seatsLeft(3, 8)).toBe(5);
    expect(seatsLeft(8, 8)).toBe(0);
  });

  it('floors free seats at zero', () => {
    // An over-full group means a bug elsewhere; the UI should say "full", not
    // "-1 free".
    expect(seatsLeft(9, 8)).toBe(0);
    expect(isFull(9, 8)).toBe(true);
  });

  it('is only full at zero seats', () => {
    expect(isFull(7, 8)).toBe(false);
    expect(isFull(8, 8)).toBe(true);
  });
});

describe('canRequestToJoin', () => {
  const open = {
    status: 'forming' as GroupStatus,
    member_count: 3,
    max_members: 8,
    already_requested: false,
  };

  it('allows a request into a live group with room', () => {
    expect(canRequestToJoin(open)).toBe(true);
    expect(canRequestToJoin({ ...open, status: 'dormant' })).toBe(true);
  });

  it('refuses closed groups', () => {
    expect(canRequestToJoin({ ...open, status: 'archived' })).toBe(false);
    expect(canRequestToJoin({ ...open, status: 'disbanded' })).toBe(false);
  });

  it('refuses a full group', () => {
    expect(canRequestToJoin({ ...open, member_count: 8 })).toBe(false);
  });

  it('refuses a second request from the same student', () => {
    expect(canRequestToJoin({ ...open, already_requested: true })).toBe(false);
  });
});

describe('canInvite', () => {
  const group = {
    status: 'forming' as GroupStatus,
    is_discoverable: true,
    max_members: 8,
  };

  it('lets the creator invite', () => {
    expect(canInvite('creator', group, 3)).toBe(true);
    // Creator can invite even when the group is hidden from browse — that is
    // precisely how an invite-only group grows.
    expect(canInvite('creator', { ...group, is_discoverable: false }, 3)).toBe(true);
  });

  it('lets a plain member invite only into a discoverable group', () => {
    expect(canInvite('member', group, 3)).toBe(true);
    expect(canInvite('member', { ...group, is_discoverable: false }, 3)).toBe(false);
  });

  it('refuses a full group, whoever is asking', () => {
    // Inviting into a full group produces an invitation that can only fail on
    // accept, which wastes the other student's time.
    expect(canInvite('creator', group, 8)).toBe(false);
    expect(canInvite('member', group, 8)).toBe(false);
  });

  it('refuses a closed group', () => {
    expect(canInvite('creator', { ...group, status: 'archived' }, 3)).toBe(false);
    expect(canInvite('creator', { ...group, status: 'disbanded' }, 3)).toBe(false);
  });
});

describe('isCreator', () => {
  it('is true only for the creator role', () => {
    expect(isCreator('creator')).toBe(true);
    expect(isCreator('member')).toBe(false);
  });

  it('handles the unknown-role case', () => {
    // role is null while a detail read is in flight, and for a non-member.
    expect(isCreator(null)).toBe(false);
    expect(isCreator(undefined)).toBe(false);
  });
});

describe('names', () => {
  it('uses the student’s name when there is one', () => {
    expect(displayName('Adebayo Okonkwo')).toBe('Adebayo Okonkwo');
    expect(displayName('  Ada  ')).toBe('Ada');
  });

  it('falls back rather than rendering a blank row', () => {
    // full_name is nullable: a student can finish auth before onboarding writes
    // their profile, and an empty row looks like a loading bug.
    expect(displayName(null)).toBe('Unnamed student');
    expect(displayName(undefined)).toBe('Unnamed student');
    expect(displayName('   ')).toBe('Unnamed student');
  });

  it('marks the creator on a roster line, and nobody else', () => {
    expect(memberLine(member({ role: 'creator' }))).toBe('Adebayo Okonkwo (creator)');
    expect(memberLine(member())).toBe('Adebayo Okonkwo');
    expect(memberLine(member({ full_name: null, role: 'creator' }))).toBe(
      'Unnamed student (creator)'
    );
  });
});

describe('defaultGroupName', () => {
  it('suggests a name from the course code', () => {
    expect(defaultGroupName('CSC 201')).toBe('CSC 201 Study Group');
  });

  it('degrades to a generic name when the code is unknown', () => {
    expect(defaultGroupName(null)).toBe('Study Group');
    expect(defaultGroupName(undefined)).toBe('Study Group');
    expect(defaultGroupName('   ')).toBe('Study Group');
  });

  it('stays within the 80-character group_name limit for real codes', () => {
    // The suggestion is pre-filled into a field validated against the DB CHECK,
    // so a suggestion that cannot be saved would be a dead end.
    expect(defaultGroupName('CSC 201').length).toBeLessThanOrEqual(80);
  });
});

describe('sortMyGroups', () => {
  it('puts live groups before closed ones', () => {
    const sorted = sortMyGroups([
      myGroup({ group_id: 'archived', status: 'archived' }),
      myGroup({ group_id: 'live', status: 'active' }),
    ]);
    expect(sorted.map((g) => g.group_id)).toEqual(['live', 'archived']);
  });

  it('orders by most recent activity within a bucket', () => {
    const sorted = sortMyGroups([
      myGroup({ group_id: 'old', last_activity_at: '2026-08-01T10:00:00Z' }),
      myGroup({ group_id: 'new', last_activity_at: '2026-09-01T10:00:00Z' }),
    ]);
    expect(sorted.map((g) => g.group_id)).toEqual(['new', 'old']);
  });

  it('keeps a stale live group above a busy closed one', () => {
    // Recency does not outrank liveness: a group you cannot act in should never
    // sit at the top of the list.
    const sorted = sortMyGroups([
      myGroup({
        group_id: 'busy-archived',
        status: 'archived',
        last_activity_at: '2026-09-05T10:00:00Z',
      }),
      myGroup({
        group_id: 'stale-live',
        status: 'dormant',
        last_activity_at: '2026-07-01T10:00:00Z',
      }),
    ]);
    expect(sorted.map((g) => g.group_id)).toEqual(['stale-live', 'busy-archived']);
  });

  it('does not mutate its input', () => {
    const input = [
      myGroup({ group_id: 'a', status: 'archived' }),
      myGroup({ group_id: 'b', status: 'active' }),
    ];
    sortMyGroups(input);
    expect(input.map((g) => g.group_id)).toEqual(['a', 'b']);
  });
});

describe('scorePercent', () => {
  it('rounds a score to a whole percent', () => {
    expect(scorePercent(0.784)).toBe(78);
    expect(scorePercent(0.785)).toBe(79);
    expect(scorePercent(0)).toBe(0);
    expect(scorePercent(1)).toBe(100);
  });

  it('clamps out-of-range input', () => {
    // The scorer keeps scores in [0, 1]; the badge must not print "142% match"
    // if a weighting change ever breaks that.
    expect(scorePercent(1.4)).toBe(100);
    expect(scorePercent(-0.2)).toBe(0);
  });

  it('survives a non-finite score', () => {
    // A zero divisor upstream should degrade the badge, not crash the card.
    expect(scorePercent(Number.NaN)).toBe(0);
    expect(scorePercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('matching preference', () => {
  const PREFS: MatchingPref[] = ['system', 'self_organized'];

  it('labels and explains both preferences', () => {
    for (const pref of PREFS) {
      expect(MATCHING_PREF_LABEL[pref].length).toBeGreaterThan(0);
      expect(MATCHING_PREF_HINT[pref].length).toBeGreaterThan(0);
    }
  });

  it('never describes opting out as losing the rest of group formation', () => {
    // The hint is the only place the app explains the choice, and a student who
    // reads "you will not be matched" as "you cannot join groups" opts out of
    // the product rather than the batch run.
    expect(MATCHING_PREF_HINT.self_organized).toMatch(/invitation|request|brows/i);
  });

  it('pools an opted-in student who is not grouped on the course', () => {
    expect(inMatchingPool('system', false)).toBe(true);
  });

  it('excludes an opted-in student already grouped on the course', () => {
    // run-batch-matching subtracts existing members from the pool, so an opted-in
    // student who already has a group is skipped rather than placed twice.
    expect(inMatchingPool('system', true)).toBe(false);
  });

  it('excludes a self-organizing student either way', () => {
    expect(inMatchingPool('self_organized', false)).toBe(false);
    expect(inMatchingPool('self_organized', true)).toBe(false);
  });
});

/**
 * The shared-time rule, as the caption states it.
 *
 * The threshold itself lives in SQL (`group_common_availability`, 0012) and is
 * returned with the mask, so these tests are not a second copy of the rule —
 * they pin that the caption never describes a threshold the RPC did not apply.
 * Reading "3 slots where all 4 of you are free" off a majority mask is the exact
 * mistake that makes a student turn up to an empty room.
 */
describe('meetRuleLabel', () => {
  it('says "all of you" when everyone is required', () => {
    // n <= 3 in 0012: threshold equals the count.
    expect(meetRuleLabel(2, 2)).toBe('where all 2 of you are free');
    expect(meetRuleLabel(3, 3)).toBe('where all 3 of you are free');
  });

  it('names both numbers when a majority is enough', () => {
    expect(meetRuleLabel(4, 2)).toBe('where at least 2 of 4 are free');
    expect(meetRuleLabel(5, 3)).toBe('where at least 3 of 5 are free');
  });

  it('does not say "all 1 of you" to a lone member', () => {
    expect(meetRuleLabel(1, 1)).toBe('where you are free');
  });

  it('claims nothing when nobody was counted', () => {
    // members_counted is 0 when no member has a user_courses row for the
    // course; the mask is empty and the caption must not imply a group answer.
    expect(meetRuleLabel(0, 0)).toBe('where the group is free');
  });

  it('never describes a threshold above the count as a partial rule', () => {
    // Defensive: a threshold that exceeds the count could only come from a bug,
    // and "at least 4 of 3" is worse than rounding it to "all of you".
    expect(meetRuleLabel(3, 4)).toBe('where all 3 of you are free');
  });
});

describe('requiresEveryone', () => {
  it('is true exactly when the threshold takes in the whole group', () => {
    expect(requiresEveryone(2, 2)).toBe(true);
    expect(requiresEveryone(3, 3)).toBe(true);
    expect(requiresEveryone(4, 2)).toBe(false);
    expect(requiresEveryone(6, 3)).toBe(false);
  });

  it('is false with nobody counted', () => {
    // Drives which empty state shows: "no availability on file" rather than
    // "no slot works for all 0 of you".
    expect(requiresEveryone(0, 0)).toBe(false);
  });
});
