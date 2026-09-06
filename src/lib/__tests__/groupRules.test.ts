import {
  JOINABLE_STATUSES,
  MATCHING_STEP_TITLE,
  PROFICIENCY_CHOICES,
  PROFICIENCY_HINT,
  PROFICIENCY_LABEL,
  STATUS_HINT,
  STATUS_LABEL,
  asProficiency,
  canApplyForMatching,
  canInvite,
  canRequestToJoin,
  capacityLabel,
  defaultGroupName,
  displayName,
  isCreator,
  isFull,
  isJoinable,
  isLive,
  matchingStep,
  matchingStepBody,
  meetRuleLabel,
  memberLine,
  requiresEveryone,
  scorePercent,
  seatsLeft,
  serverNow,
  sortMyGroups,
  windowBanner,
  windowPhase,
  windowWhenLabel,
  type MatchingStep,
  type WindowPhase,
} from '../groupRules';
import type {
  GroupMemberDetailRow,
  GroupStatus,
  MatchingWindowState,
  MyGroupRow,
  Proficiency,
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

// ---------------------------------------------------------------------------
// How you rate yourself (user_courses.proficiency, 0020)
// ---------------------------------------------------------------------------

describe('proficiency bands', () => {
  it('words every band, twice over', () => {
    // The chip and its one-line hint are the whole of what a student reads
    // before answering, so neither may be blank for any band.
    for (const level of PROFICIENCY_CHOICES) {
      expect(PROFICIENCY_LABEL[level].length).toBeGreaterThan(0);
      expect(PROFICIENCY_HINT[level].length).toBeGreaterThan(0);
    }
  });

  it('describes the course going badly, not the student being bad at it', () => {
    // 'Struggling' has to be safe to pick — it is the answer that gets you a
    // group with somebody who can explain. Copy that grades the student instead
    // is what makes people round themselves upward and break the mixing rule.
    const copy = PROFICIENCY_CHOICES.flatMap((level) => [
      PROFICIENCY_LABEL[level],
      PROFICIENCY_HINT[level],
    ]).join(' ');
    expect(copy).not.toMatch(/\b(weak|poor|bad|stupid|smart|clever|expert|beginner)\b/i);
  });

  it('offers the bands lowest first, so none of them reads as the default', () => {
    expect(PROFICIENCY_CHOICES).toEqual([1, 2, 3]);
  });

  it('narrows a stored value and rejects everything else', () => {
    expect(asProficiency(1)).toBe(1);
    expect(asProficiency(2)).toBe(2);
    expect(asProficiency(3)).toBe(3);
    // Null is every enrolment made before 0020; the rest is what a hand-written
    // row, a loosened CHECK or a JSON round-trip could put there. All of them
    // mean "not rated", which is a step the Apply screen knows how to ask about.
    expect(asProficiency(null)).toBeNull();
    expect(asProficiency(undefined)).toBeNull();
    expect(asProficiency(0)).toBeNull();
    expect(asProficiency(4)).toBeNull();
    expect(asProficiency(2.5)).toBeNull();
    expect(asProficiency('2')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The registration period (matching_windows + matching_window_state(), 0020)
// ---------------------------------------------------------------------------

/**
 * A timestamp built from LOCAL parts.
 *
 * `windowWhenLabel` reads through `dayLabel` and `formatClock`, both of which
 * work in the device's timezone. A UTC literal would therefore make "Today"
 * depend on which machine ran the suite — green in Lagos, red in Los Angeles.
 */
function at(y: number, m: number, d: number, h = 0, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

/** A window as `matching_window_state()` returns it: open, with both ends set. */
function windowState(over: Partial<MatchingWindowState> = {}): MatchingWindowState {
  return {
    server_now: at(2026, 9, 5, 12, 0),
    is_open: true,
    window_id: 'w1',
    label: 'Semester 1 matching',
    opens_at: at(2026, 9, 1, 9, 0),
    closes_at: at(2026, 9, 12, 17, 0),
    ...over,
  };
}

describe('windowPhase', () => {
  it('separates a period that is open from one that is only scheduled', () => {
    const open: WindowPhase = windowPhase(windowState());
    expect(open).toBe('open');
    expect(windowPhase(windowState({ is_open: false }))).toBe('upcoming');
  });

  it('reads an absent period as none, however it arrives', () => {
    // The RPC answers with a row of nulls rather than no row when nothing is
    // scheduled, and the hook holds null until it answers at all. Both mean "no
    // period", and neither may read as upcoming — the Apply screen would then
    // promise a window that is never going to open.
    expect(windowPhase(windowState({ window_id: null, is_open: false }))).toBe('none');
    expect(windowPhase(null)).toBe('none');
    expect(windowPhase(undefined)).toBe('none');
  });

  it('trusts is_open over the timestamps', () => {
    // The SQL decides what open means, against its own clock. A closes_at that
    // looks past to this device is not the client's to reinterpret.
    expect(windowPhase(windowState({ closes_at: at(2026, 9, 4, 17, 0) }))).toBe('open');
  });
});

describe('serverNow', () => {
  it('dates the screen by the instant the server reported', () => {
    expect(serverNow(windowState()).toISOString()).toBe(at(2026, 9, 5, 12, 0));
  });

  it('falls back to the device clock when there is nothing to trust', () => {
    // The banner still renders while the RPC is in flight, and offline it never
    // answers. "Roughly now" is right enough to pick a day label; an Invalid Date
    // would print an empty deadline into the middle of a sentence.
    for (const state of [null, undefined, windowState({ server_now: 'not a date' })]) {
      expect(Math.abs(serverNow(state).getTime() - Date.now())).toBeLessThan(5000);
    }
  });
});

describe('windowWhenLabel', () => {
  const now = new Date(2026, 8, 5, 9, 0);

  it('reads a deadline later the same day as a time of day', () => {
    expect(windowWhenLabel(at(2026, 9, 5, 17, 30), now)).toBe('Today, 5:30pm');
  });

  it('spells out a date further off', () => {
    expect(windowWhenLabel(at(2026, 9, 12, 17, 0), now)).toBe('12 September, 5pm');
  });

  it('renders nothing at all for a missing timestamp', () => {
    // Both ends come back null when no period is scheduled, and the banner
    // interpolates this straight into a sentence.
    expect(windowWhenLabel(null)).toBe('');
    expect(windowWhenLabel(undefined)).toBe('');
  });
});

describe('windowBanner', () => {
  it('names the period and when it shuts', () => {
    expect(windowBanner(windowState())).toBe(
      'Semester 1 matching is open until 12 September, 5pm.'
    );
  });

  it('names when an upcoming period opens instead', () => {
    expect(windowBanner(windowState({ is_open: false }))).toBe(
      'Semester 1 matching opens 1 September, 9am.'
    );
  });

  it('still forms a sentence when the coordinator left the label empty', () => {
    expect(windowBanner(windowState({ label: null }))).toMatch(/^Matching is open until/);
  });

  it('dates the deadline against the server clock, not the device', () => {
    // A phone a day fast would otherwise read tonight's deadline as "Yesterday"
    // while the Apply button beside it is still live. Carrying server_now on the
    // same row as closes_at is what stops the screen contradicting itself.
    const state = windowState({
      server_now: at(2026, 9, 12, 9, 0),
      closes_at: at(2026, 9, 12, 17, 0),
    });
    expect(windowBanner(state)).toContain('Today, 5pm');
  });

  it('answers an absent period with what still works', () => {
    // The owner's rule, on 2026-09-05: a shut window is not a shut app. Only
    // automatic matching waits on it, so this line has to name the three routes
    // into a group that do not — and must not date anything.
    for (const state of [null, windowState({ window_id: null, is_open: false })]) {
      const banner = windowBanner(state);
      expect(banner).toMatch(/brows/i);
      expect(banner).toMatch(/join/i);
      expect(banner).toMatch(/your own/i);
      expect(banner).not.toMatch(/until|opens/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Where one enrolment stands in the matching flow (0020)
// ---------------------------------------------------------------------------

/** Listed out, so adding a sixth step fails here as well as in the type. */
const ALL_STEPS: MatchingStep[] = [
  'grouped',
  'applied',
  'needs_rating',
  'needs_availability',
  'ready',
];

/** An enrolment as the Apply screen sees it: rated, never applied. */
function enrolment(over: { proficiency?: Proficiency | null; applied_at?: string | null } = {}) {
  return { proficiency: 2 as Proficiency | null, applied_at: null as string | null, ...over };
}

describe('matchingStep', () => {
  it('is ready once the course is rated and some free time is picked', () => {
    const step: MatchingStep = matchingStep(enrolment(), 6, false);
    expect(step).toBe('ready');
  });

  it('asks for the rating first when both are missing', () => {
    // Both are blank on a course just added, and only one thing may ever be
    // asked for at a time. The rating goes first because it is one tap on the
    // courses screen, where the grid is a screenful of them.
    expect(matchingStep(enrolment({ proficiency: null }), 0, false)).toBe('needs_rating');
    expect(matchingStep(enrolment({ proficiency: null }), 6, false)).toBe('needs_rating');
    expect(matchingStep(enrolment({ proficiency: 3 }), 0, false)).toBe('needs_availability');
  });

  it('resolves grouped before applied, because applied_at is never cleared', () => {
    // The reason that precedence is written down: matched state is DERIVED from
    // membership rather than stored. Read the other way round, a student the run
    // had already placed would sit there being told they were still waiting.
    const applied = enrolment({ proficiency: 1, applied_at: at(2026, 9, 2, 10, 0) });
    expect(matchingStep(applied, 6, true)).toBe('grouped');
    expect(matchingStep(applied, 6, false)).toBe('applied');
  });

  it('says grouped even for a course that could never have applied', () => {
    // A group joined by invitation or an approved request, on a course with no
    // rating and no free time picked. There is nothing left to fix here, so
    // nothing may be asked for.
    expect(matchingStep(enrolment({ proficiency: null }), 0, true)).toBe('grouped');
  });

  it('holds an application whatever the rating and free time say afterwards', () => {
    // Availability stays editable after applying — the profile screen is not
    // locked — and the pool has already been joined. Sliding back to
    // needs_availability would offer an Apply button for something that cannot
    // be applied for twice.
    expect(matchingStep(enrolment({ proficiency: null, applied_at: at(2026, 9, 2, 10, 0) }), 0, false)).toBe(
      'applied'
    );
  });
});

describe('what each step says', () => {
  const ALL_PHASES: WindowPhase[] = ['open', 'upcoming', 'none'];

  it('titles and explains every step, in every phase', () => {
    for (const step of ALL_STEPS) {
      expect(MATCHING_STEP_TITLE[step].length).toBeGreaterThan(0);
      for (const phase of ALL_PHASES) {
        expect(matchingStepBody(step, phase).length).toBeGreaterThan(0);
      }
    }
  });

  it('lets the window reword one step and one step only', () => {
    // The period gates a single action, so it may change the wording of a single
    // step. If a second one starts reading differently by phase, the screen has
    // begun implying the window blocks more than applying — which is exactly the
    // reading the owner ruled out.
    for (const step of ALL_STEPS.filter((s) => s !== 'ready')) {
      expect(matchingStepBody(step, 'upcoming')).toBe(matchingStepBody(step, 'open'));
      expect(matchingStepBody(step, 'none')).toBe(matchingStepBody(step, 'open'));
    }
    expect(matchingStepBody('ready', 'none')).not.toBe(matchingStepBody('ready', 'open'));
  });

  it('tells a ready student with no open period what to do instead', () => {
    // The banner's rule again, in the place the student is actually looking: the
    // card whose button is greyed out. An upcoming period reads the same, since
    // browsing and invitations work just as well while one is pending.
    const body = matchingStepBody('ready', 'none');
    expect(body).toMatch(/brows/i);
    expect(body).toMatch(/invit/i);
    expect(matchingStepBody('ready', 'upcoming')).toBe(body);
  });

  it('warns that applying goes one way before the tap, and again after', () => {
    expect(matchingStepBody('ready', 'open')).toMatch(/only goes one way/i);
    expect(matchingStepBody('applied', 'open')).toMatch(/cannot withdraw/i);
  });

  it('promises the derived pool, so leaving a group is not a re-application', () => {
    const body = matchingStepBody('grouped', 'open');
    expect(body).toMatch(/leave/i);
    expect(body).toMatch(/pool/i);
  });
});

describe('canApplyForMatching', () => {
  it('needs a ready course and an open period, both', () => {
    expect(canApplyForMatching('ready', 'open')).toBe(true);
    expect(canApplyForMatching('ready', 'upcoming')).toBe(false);
    expect(canApplyForMatching('ready', 'none')).toBe(false);
  });

  it('refuses every other step even while the period is open', () => {
    // Mirrors request_matching's own gate. The RPC is the enforcement and this
    // only decides whether the button is tappable — but a tappable button that
    // always fails is a bug in its own right.
    for (const step of ALL_STEPS.filter((s) => s !== 'ready')) {
      expect(canApplyForMatching(step, 'open')).toBe(false);
    }
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
