/**
 * Resume ↔ job-description matching.
 *
 * Lives in the API rather than the worker on purpose: the worker computes the score so it can
 * decide whether to open an application at all, and the API recomputes it at the write. A
 * worker that scored generously — through a bug, a stale build, or a bad selector returning
 * an empty description — cannot get a weak match into the record.
 *
 * ## What a score is, and what it is not
 *
 * This is a deterministic, explainable scoring function over text. It is not a judgement that
 * a person is right for a job, and a 97 is not a promise. What it does guarantee is that the
 * same resume and the same description always produce the same number, and that the number
 * can be taken apart afterwards — every component is stored with the application, so "why did
 * we apply to this?" is answerable months later without re-fetching a posting that may be
 * gone.
 *
 * Because it is text overlap, it is blind to things a person would catch: an employer using
 * unusual vocabulary for a skill the candidate has, a title that means something different at
 * that company, a description that is mostly boilerplate. Those failure modes push the score
 * *down*, not up, which is the safe direction — the cost is a missed application, not a wrong
 * one.
 *
 * ## Why "no description" is a hard zero
 *
 * If the adapter cannot read the job description, the honest score is not "assume it is fine"
 * — it is zero. Otherwise a broken selector silently degrades into applying to everything,
 * which is the exact failure this whole feature exists to prevent.
 */

/** Nothing below this is applied to, whatever a user's threshold is set to. */
export const MIN_ALLOWED_MATCH_SCORE = 90;
export const DEFAULT_MATCH_SCORE = 95;

/** Descriptions shorter than this are treated as unread rather than as a poor match. */
const MIN_USABLE_DESCRIPTION_CHARS = 200;

export interface ResumeProfile {
  /** Full resume text. The prose carries seniority and domain vocabulary the skill list does not. */
  rawText: string;
  skills: string[];
  yearsExperience: number | null;
  /** Roles the job seeker is actually targeting, from their profile. */
  targetDesignations: string[];
}

export interface JobPosting {
  title: string;
  company: string;
  location?: string | null;
  /** The full description from the job's own page, not the search-result snippet. */
  description: string;
}

export interface MatchComponent {
  key: string;
  label: string;
  /** 0-1 before weighting. */
  score: number;
  weight: number;
  detail: string;
}

export interface MatchResult {
  /** 0-100, rounded. */
  score: number;
  components: MatchComponent[];
  /** Skills the description asks for that the resume does not evidence. */
  missingSkills: string[];
  matchedSkills: string[];
  /** Set when the posting could not be scored at all. */
  unscorable: string | null;
}

/* ------------------------------------------------------------------ text utilities */

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'our', 'with', 'will', 'are', 'this', 'that', 'have', 'from',
  'your', 'they', 'their', 'has', 'was', 'were', 'been', 'its', 'not', 'but', 'can', 'all',
  'who', 'about', 'into', 'more', 'other', 'than', 'then', 'them', 'these', 'those', 'such',
  'work', 'team', 'role', 'job', 'position', 'company', 'opportunity', 'candidate', 'ability',
  'experience', 'years', 'strong', 'excellent', 'good', 'great', 'must', 'should', 'would',
  'including', 'across', 'within', 'while', 'also', 'help', 'make', 'new', 'well', 'may',
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    // Keep + and # so c++ and c# survive; keep . so node.js does.
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): string[] {
  return normalize(text)
    .split(' ')
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Whether a skill appears in the text, allowing for the ways skills get written.
 * "Node.js" must match "nodejs" and "node"; "C++" must not match "c".
 */
function mentions(haystack: string, skill: string): boolean {
  const norm = normalize(skill);
  if (!norm) return false;

  const variants = new Set<string>([norm]);
  variants.add(norm.replace(/\./g, ''));
  variants.add(norm.replace(/[.\s-]/g, ''));
  if (norm.endsWith('.js')) variants.add(norm.slice(0, -3));
  if (norm.endsWith('js') && norm.length > 3) variants.add(`${norm.slice(0, -2)}.js`);

  for (const variant of variants) {
    if (!variant) continue;
    // Word-boundary-ish match. Symbols like + and # are not word chars, so a plain \b fails
    // on "c++" — anchor on whitespace or string edges instead.
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)) return true;
  }
  return false;
}

/**
 * Skills a description actually asks for. Drawn from the job seeker's own skill vocabulary
 * plus terms the description emphasises, rather than from a fixed taxonomy that would go
 * stale and silently stop matching.
 */
function requiredSkills(description: string, knownSkills: string[]): string[] {
  const norm = normalize(description);
  return knownSkills.filter((skill) => mentions(norm, skill));
}

/** Jaccard overlap of the two token sets, which is what "same subject matter" reduces to. */
function tokenOverlap(a: string, b: string): { score: number; shared: number; total: number } {
  const setA = new Set(tokens(a));
  const setB = new Set(tokens(b));
  if (!setA.size || !setB.size) return { score: 0, shared: 0, total: 0 };

  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;

  // Asymmetric on purpose: what matters is how much of the *description* the resume covers,
  // not how much of a long resume the description happens to mention.
  return { score: shared / setB.size, shared, total: setB.size };
}

/* ------------------------------------------------------------------ seniority */

const SENIORITY_RANK: Record<string, number> = {
  intern: 0, internship: 0, trainee: 0,
  junior: 1, entry: 1, associate: 1, graduate: 1,
  mid: 2, intermediate: 2,
  senior: 3, sr: 3,
  staff: 4, lead: 4, principal: 5, architect: 5,
  manager: 4, director: 6, head: 6, vp: 7,
};

function seniorityOf(text: string): number | null {
  const t = normalize(text);
  let found: number | null = null;
  for (const [word, rank] of Object.entries(SENIORITY_RANK)) {
    if (new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(t)) {
      found = found === null ? rank : Math.max(found, rank);
    }
  }
  return found;
}

/** Years of experience the description asks for, e.g. "5+ years", "3-5 years". */
function requiredYears(description: string): number | null {
  const matches = [...description.matchAll(/(\d{1,2})\s*(?:\+|plus)?\s*(?:-\s*\d{1,2}\s*)?year/gi)];
  if (!matches.length) return null;
  const values = matches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n) && n <= 25);
  if (!values.length) return null;
  // The lowest stated figure is the actual bar; higher ones are usually "5-8 years" ranges
  // or unrelated ("10 years of company history").
  return Math.min(...values);
}

/* ------------------------------------------------------------------ the score */

export function scoreMatch(resume: ResumeProfile, job: JobPosting): MatchResult {
  const description = (job.description ?? '').trim();

  if (description.length < MIN_USABLE_DESCRIPTION_CHARS) {
    return {
      score: 0,
      components: [],
      missingSkills: [],
      matchedSkills: [],
      unscorable: `Job description was ${description.length} characters; need at least ${MIN_USABLE_DESCRIPTION_CHARS} to judge a match`,
    };
  }
  if (!resume.rawText || resume.rawText.trim().length < MIN_USABLE_DESCRIPTION_CHARS) {
    return {
      score: 0,
      components: [],
      missingSkills: [],
      matchedSkills: [],
      unscorable: 'Resume text is missing or too short to match against',
    };
  }

  const resumeText = normalize(resume.rawText);
  const jobText = normalize(`${job.title} ${description}`);
  const components: MatchComponent[] = [];

  // --- 1. skills the posting asks for, that the resume evidences -------------------------
  const asked = requiredSkills(description, resume.skills);
  const matchedSkills = asked.filter((s) => mentions(resumeText, s));
  const missingSkills = asked.filter((s) => !mentions(resumeText, s));

  // A description mentioning none of the candidate's skills is a different situation from one
  // mentioning ten and matching nine. With nothing asked for, this component says nothing
  // rather than awarding a free full mark.
  const skillScore = asked.length ? matchedSkills.length / asked.length : 0;
  components.push({
    key: 'skills',
    label: 'Skills the posting asks for',
    score: skillScore,
    weight: asked.length ? 0.4 : 0,
    detail: asked.length
      ? `${matchedSkills.length} of ${asked.length} matched: ${matchedSkills.join(', ') || 'none'}`
      : 'The description names none of this profile’s skills',
  });

  // --- 2. role/title alignment ----------------------------------------------------------
  const titleTargets = [...resume.targetDesignations, ...resume.skills.slice(0, 5)].join(' ');
  const titleHit = resume.targetDesignations.some(
    (d) => mentions(normalize(job.title), d) || mentions(normalize(d), job.title),
  );
  const titleTokens = tokenOverlap(titleTargets, job.title);
  const titleScore = titleHit ? 1 : titleTokens.score;
  components.push({
    key: 'title',
    label: 'Role alignment',
    score: titleScore,
    weight: 0.25,
    detail: titleHit
      ? `"${job.title}" matches a target role`
      : `"${job.title}" shares ${titleTokens.shared}/${titleTokens.total} terms with the target roles`,
  });

  // --- 3. how much of the description the resume covers ---------------------------------
  const bodyOverlap = tokenOverlap(resume.rawText, description);
  // Raw Jaccard against a long description tops out low even for a strong fit, so rescale:
  // covering 45% of a description's meaningful terms is treated as full marks.
  const bodyScore = Math.min(1, bodyOverlap.score / 0.45);
  components.push({
    key: 'description',
    label: 'Description coverage',
    score: bodyScore,
    weight: 0.2,
    detail: `Resume covers ${Math.round(bodyOverlap.score * 100)}% of the description’s distinctive terms`,
  });

  // --- 4. seniority ---------------------------------------------------------------------
  const jobSeniority = seniorityOf(job.title) ?? seniorityOf(description.slice(0, 600));
  const resumeSeniority = seniorityOf(resume.targetDesignations.join(' ')) ?? seniorityOf(resumeText.slice(0, 1200));
  let seniorityScore = 1;
  let seniorityDetail = 'No seniority stated either side';
  if (jobSeniority !== null && resumeSeniority !== null) {
    const gap = Math.abs(jobSeniority - resumeSeniority);
    seniorityScore = gap === 0 ? 1 : gap === 1 ? 0.75 : gap === 2 ? 0.35 : 0;
    seniorityDetail = gap === 0 ? 'Seniority matches' : `Seniority differs by ${gap} level${gap === 1 ? '' : 's'}`;
  }
  components.push({
    key: 'seniority',
    label: 'Seniority',
    score: seniorityScore,
    weight: 0.1,
    detail: seniorityDetail,
  });

  // --- 5. years of experience -----------------------------------------------------------
  const needYears = requiredYears(description);
  let yearsScore = 1;
  let yearsDetail = 'No experience requirement stated';
  if (needYears !== null && resume.yearsExperience !== null) {
    if (resume.yearsExperience >= needYears) {
      yearsScore = 1;
      yearsDetail = `Asks for ${needYears}+ years; resume shows ${resume.yearsExperience}`;
    } else {
      const shortfall = needYears - resume.yearsExperience;
      yearsScore = shortfall <= 1 ? 0.8 : shortfall <= 2 ? 0.5 : 0;
      yearsDetail = `Asks for ${needYears}+ years; resume shows ${resume.yearsExperience}`;
    }
  } else if (needYears !== null) {
    yearsScore = 0.6;
    yearsDetail = `Asks for ${needYears}+ years; resume years could not be determined`;
  }
  components.push({
    key: 'years',
    label: 'Experience',
    score: yearsScore,
    weight: 0.05,
    detail: yearsDetail,
  });

  // --- weighted total -------------------------------------------------------------------
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const weighted = components.reduce((sum, c) => sum + c.score * c.weight, 0);
  let score = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : 0;

  // A posting that names a required skill the resume does not evidence cannot be a 100. This
  // is a ceiling rather than a subtraction so it cannot be averaged away by strong components.
  if (missingSkills.length) {
    const ceiling = Math.max(0, 100 - missingSkills.length * 6);
    score = Math.min(score, ceiling);
  }
  // Nor can something that is not the right kind of role, however much vocabulary it shares.
  if (titleScore < 0.34) score = Math.min(score, 70);

  void jobText;

  return {
    score: Math.max(0, Math.min(100, score)),
    components,
    missingSkills,
    matchedSkills,
    unscorable: null,
  };
}

/** The bar for a given user, floored at MIN_ALLOWED_MATCH_SCORE. */
export function thresholdFor(userMinScore: number | null | undefined): number {
  const requested = Number(userMinScore ?? DEFAULT_MATCH_SCORE);
  if (!Number.isFinite(requested)) return DEFAULT_MATCH_SCORE;
  return Math.max(MIN_ALLOWED_MATCH_SCORE, Math.min(100, Math.round(requested)));
}
