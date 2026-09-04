-- ============================================================================
-- StudySync — Stage 1 seed data: courses + curated topic lists
-- ----------------------------------------------------------------------------
-- Run AFTER 0001 and 0002.
--
-- >>> READ THIS BEFORE RUNNING <<<
--
-- These courses and topics are PLACEHOLDERS. The course codes follow the
-- general Nigerian university convention (three-letter dept prefix + level
-- digit), and the topics are drawn from what these subjects conventionally
-- cover — but I have not seen the University of Ibadan syllabus and cannot
-- verify any of it.
--
-- Check every row against real course outlines before your pilot. Wrong topic
-- lists degrade matching quality directly: the topic score is weighted
-- heaviest (0.5) in the compatibility formula, so a topic list that does not
-- reflect what students actually study will produce confident bad matches.
--
-- Safe to re-run: `on conflict do nothing` throughout.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Courses
-- ---------------------------------------------------------------------------
insert into public.courses (course_code, course_title, department) values
  ('CSC 201', 'Computer Programming I',        'Computer Science'),
  ('CSC 203', 'Discrete Structures',           'Computer Science'),
  ('CSC 301', 'Data Structures and Algorithms','Computer Science'),
  ('MTH 201', 'Mathematical Methods I',        'Mathematics'),
  ('MTH 241', 'Linear Algebra',                'Mathematics'),
  ('ECO 201', 'Microeconomic Theory I',        'Economics'),
  ('ECO 203', 'Macroeconomic Theory I',        'Economics'),
  ('PHY 201', 'Classical Mechanics',           'Physics'),
  ('CHM 201', 'Physical Chemistry I',          'Chemistry'),
  ('BIO 201', 'General Physiology',            'Biology')
on conflict (course_code) do nothing;

-- ---------------------------------------------------------------------------
-- Topics, keyed by course_code so this file stays readable and re-runnable.
--
-- Aim for 6-12 topics per course. Too few and every student overlaps with
-- every other student, so the topic score stops discriminating. Too many and
-- overlap becomes sparse, so genuinely compatible students score zero.
-- ---------------------------------------------------------------------------
with topic_data (course_code, topic_name, sort_order) as (values
  -- CSC 201 — Computer Programming I
  ('CSC 201', 'Variables and Data Types',        1),
  ('CSC 201', 'Control Flow and Loops',          2),
  ('CSC 201', 'Functions and Scope',             3),
  ('CSC 201', 'Arrays and Strings',              4),
  ('CSC 201', 'Pointers and Memory',             5),
  ('CSC 201', 'Recursion',                       6),
  ('CSC 201', 'File Input and Output',           7),
  ('CSC 201', 'Debugging and Testing',           8),

  -- CSC 203 — Discrete Structures
  ('CSC 203', 'Propositional Logic',             1),
  ('CSC 203', 'Set Theory',                      2),
  ('CSC 203', 'Relations and Functions',         3),
  ('CSC 203', 'Combinatorics',                   4),
  ('CSC 203', 'Graph Theory',                    5),
  ('CSC 203', 'Trees',                           6),
  ('CSC 203', 'Mathematical Induction',          7),
  ('CSC 203', 'Recurrence Relations',            8),

  -- CSC 301 — Data Structures and Algorithms
  ('CSC 301', 'Complexity and Big-O',            1),
  ('CSC 301', 'Linked Lists',                    2),
  ('CSC 301', 'Stacks and Queues',               3),
  ('CSC 301', 'Trees and Binary Search Trees',   4),
  ('CSC 301', 'Heaps and Priority Queues',       5),
  ('CSC 301', 'Hash Tables',                     6),
  ('CSC 301', 'Sorting Algorithms',              7),
  ('CSC 301', 'Graph Traversal',                 8),
  ('CSC 301', 'Dynamic Programming',             9),

  -- MTH 201 — Mathematical Methods I
  ('MTH 201', 'Limits and Continuity',           1),
  ('MTH 201', 'Differentiation',                 2),
  ('MTH 201', 'Integration Techniques',          3),
  ('MTH 201', 'Sequences and Series',            4),
  ('MTH 201', 'Partial Derivatives',             5),
  ('MTH 201', 'Ordinary Differential Equations', 6),
  ('MTH 201', 'Complex Numbers',                 7),

  -- MTH 241 — Linear Algebra
  ('MTH 241', 'Matrices and Determinants',       1),
  ('MTH 241', 'Systems of Linear Equations',     2),
  ('MTH 241', 'Vector Spaces',                   3),
  ('MTH 241', 'Linear Transformations',          4),
  ('MTH 241', 'Eigenvalues and Eigenvectors',    5),
  ('MTH 241', 'Inner Product Spaces',            6),
  ('MTH 241', 'Diagonalisation',                 7),

  -- ECO 201 — Microeconomic Theory I
  ('ECO 201', 'Consumer Theory',                 1),
  ('ECO 201', 'Utility and Indifference Curves', 2),
  ('ECO 201', 'Demand and Elasticity',           3),
  ('ECO 201', 'Theory of Production',            4),
  ('ECO 201', 'Cost Curves',                     5),
  ('ECO 201', 'Perfect Competition',             6),
  ('ECO 201', 'Monopoly and Market Power',       7),
  ('ECO 201', 'Factor Markets',                  8),

  -- ECO 203 — Macroeconomic Theory I
  ('ECO 203', 'National Income Accounting',      1),
  ('ECO 203', 'Consumption and Savings',         2),
  ('ECO 203', 'Investment and Multiplier',       3),
  ('ECO 203', 'Money and Banking',               4),
  ('ECO 203', 'IS-LM Model',                     5),
  ('ECO 203', 'Inflation and Unemployment',      6),
  ('ECO 203', 'Fiscal and Monetary Policy',      7),

  -- PHY 201 — Classical Mechanics
  ('PHY 201', 'Kinematics',                      1),
  ('PHY 201', 'Newtons Laws',                    2),
  ('PHY 201', 'Work Energy and Power',           3),
  ('PHY 201', 'Momentum and Collisions',         4),
  ('PHY 201', 'Rotational Dynamics',             5),
  ('PHY 201', 'Simple Harmonic Motion',          6),
  ('PHY 201', 'Gravitation',                     7),
  ('PHY 201', 'Lagrangian Mechanics',            8),

  -- CHM 201 — Physical Chemistry I
  ('CHM 201', 'Gas Laws',                        1),
  ('CHM 201', 'First Law of Thermodynamics',     2),
  ('CHM 201', 'Second Law and Entropy',          3),
  ('CHM 201', 'Chemical Equilibrium',            4),
  ('CHM 201', 'Phase Equilibria',                5),
  ('CHM 201', 'Chemical Kinetics',               6),
  ('CHM 201', 'Electrochemistry',                7),

  -- BIO 201 — General Physiology
  ('BIO 201', 'Cell Membrane Transport',         1),
  ('BIO 201', 'Nervous System',                  2),
  ('BIO 201', 'Muscle Physiology',               3),
  ('BIO 201', 'Cardiovascular System',           4),
  ('BIO 201', 'Respiratory System',              5),
  ('BIO 201', 'Renal Physiology',                6),
  ('BIO 201', 'Endocrine System',                7),
  ('BIO 201', 'Digestive System',                8)
)
insert into public.topics (course_id, topic_name, sort_order)
select c.course_id, t.topic_name, t.sort_order
from topic_data t
join public.courses c on c.course_code = t.course_code
on conflict (course_id, topic_name) do nothing;

-- ---------------------------------------------------------------------------
-- Sanity check — expect 10 courses, and each with a non-zero topic count.
-- ---------------------------------------------------------------------------
-- select c.course_code, c.course_title, count(t.topic_id) as topics
-- from public.courses c
-- left join public.topics t on t.course_id = c.course_id
-- group by c.course_code, c.course_title
-- order by c.course_code;
