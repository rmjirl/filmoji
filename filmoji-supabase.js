/**
 * filmoji-supabase.js
 * Drop-in Supabase integration for Filmoji (vanilla JS, no build step).
 *
 * SETUP:
 *   1. Add to your HTML <head> before this script:
 *      <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *
 *   2. Replace the two constants below with your project values
 *      (Supabase dashboard → Settings → API):
 */

const SUPABASE_URL  = 'https://ahtwvvfrwldbcvxoogsp.supabase.co';
const SUPABASE_ANON = 'sb_publishable_U9QXLlRSWDwLvKaAC_9-bw_yEttDOgZ';

// ─── Init ────────────────────────────────────────────────────────────────────
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// localStorage keys
const LS_HISTORY = 'filmoji_history';   // array of daily result objects (anon)
const LS_STREAK  = 'filmoji_streak';    // { current, longest, lastPlayed }

// ─── Local (anonymous) helpers ───────────────────────────────────────────────

/**
 * Returns the stored local history array.
 * Each entry: { puzzle_date, solved, guesses_used, time_seconds, hints_used }
 */
function getLocalHistory() {
  try {
    return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
  } catch { return []; }
}

/**
 * Saves a puzzle result to localStorage.
 * Called for every player, authed or not.
 */
function saveLocalResult(result) {
  const history = getLocalHistory();
  const idx = history.findIndex(r => r.puzzle_date === result.puzzle_date);
  if (idx >= 0) history[idx] = result; else history.push(result);
  localStorage.setItem(LS_HISTORY, JSON.stringify(history));
  _updateLocalStreak(result);
}

function _updateLocalStreak(result) {
  const raw    = localStorage.getItem(LS_STREAK);
  const streak = raw ? JSON.parse(raw) : { current: 0, longest: 0, lastPlayed: null };
  const today  = result.puzzle_date;

  if (!result.solved) {
    streak.current    = 0;
    streak.lastPlayed = today;
  } else if (!streak.lastPlayed) {
    streak.current    = 1;
    streak.longest    = 1;
    streak.lastPlayed = today;
  } else {
    const last    = new Date(streak.lastPlayed);
    const current = new Date(today);
    const diff    = (current - last) / 86400000; // days

    if (diff === 1) {
      streak.current   += 1;
      streak.longest    = Math.max(streak.current, streak.longest);
    } else if (diff > 1) {
      streak.current    = 1;
    }
    // diff === 0 → same day, don't change streak
    streak.lastPlayed = today;
  }

  localStorage.setItem(LS_STREAK, JSON.stringify(streak));
}

/** Returns local streak object { current, longest, lastPlayed } */
function getLocalStreak() {
  try {
    return JSON.parse(localStorage.getItem(LS_STREAK) || '{}');
  } catch { return { current: 0, longest: 0, lastPlayed: null }; }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Sign in with Google (opens OAuth popup/redirect).
 * After sign-in, call migrateLocalHistoryToDb() to upload anon history.
 */
async function signInWithGoogle() {
  const { error } = await _sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) console.error('Filmoji auth error:', error.message);
}

/** Sign out. Local history is preserved in localStorage. */
async function signOut() {
  await _sb.auth.signOut();
}

/** Returns the current Supabase session, or null if anonymous. */
async function getSession() {
  const { data } = await _sb.auth.getSession();
  return data?.session ?? null;
}

/** Returns the current user, or null. */
async function getUser() {
  const session = await getSession();
  return session?.user ?? null;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

/**
 * Save a puzzle result to Supabase.
 * Only call this when the user is authenticated.
 */
async function saveDbResult(result) {
  const user = await getUser();
  if (!user) return { error: 'not authenticated' };

  const { error } = await _sb
    .from('puzzle_results')
    .upsert({
      user_id:      user.id,
      puzzle_date:  result.puzzle_date,
      solved:       result.solved,
      guesses_used: result.guesses_used,
      time_seconds: result.time_seconds,
      hints_used:   result.hints_used,
    }, { onConflict: 'user_id,puzzle_date' });

  return { error };
}

/**
 * Migrate local anon history into Supabase after the user signs up.
 * Call this once, right after a successful OAuth redirect.
 */
async function migrateLocalHistoryToDb() {
  const history = getLocalHistory();
  if (!history.length) return;

  const user = await getUser();
  if (!user) return;

  const rows = history.map(r => ({
    user_id:      user.id,
    puzzle_date:  r.puzzle_date,
    solved:       r.solved,
    guesses_used: r.guesses_used,
    time_seconds: r.time_seconds,
    hints_used:   r.hints_used,
  }));

  const { error } = await _sb
    .from('puzzle_results')
    .upsert(rows, { onConflict: 'user_id,puzzle_date' });

  if (error) {
    console.error('Migration error:', error.message);
  } else {
    console.log(`Migrated ${rows.length} local results to Supabase.`);
  }
}

/**
 * Fetch the current user's streak from Supabase.
 * Falls back to local streak if unauthenticated.
 */
async function getStreak() {
  const user = await getUser();
  if (!user) return getLocalStreak();

  const { data, error } = await _sb
    .from('streaks')
    .select('current_streak, longest_streak, last_played')
    .eq('user_id', user.id)
    .single();

  if (error || !data) return getLocalStreak();

  return {
    current:    data.current_streak,
    longest:    data.longest_streak,
    lastPlayed: data.last_played,
  };
}

/**
 * Fetch the global leaderboard (top N players).
 */
async function getLeaderboard(limit = 20) {
  const { data, error } = await _sb
    .from('leaderboard')
    .select('username, avatar_url, total_score, puzzles_solved, current_streak, longest_streak')
    .limit(limit);

  if (error) { console.error(error); return []; }
  return data;
}

/**
 * Fetch the current user's full result history from Supabase.
 */
async function getUserHistory() {
  const user = await getUser();
  if (!user) return getLocalHistory();

  const { data, error } = await _sb
    .from('puzzle_results')
    .select('*')
    .eq('user_id', user.id)
    .order('puzzle_date', { ascending: false });

  if (error) return [];
  return data;
}

// ─── Streak-gate prompt ───────────────────────────────────────────────────────

/**
 * Call this after saving every result.
 * Returns true if you should show the "save your streak" prompt.
 *
 * Trigger condition: current streak >= 5 AND user is not yet authenticated.
 */
async function shouldPromptSignUp() {
  const user = await getUser();
  if (user) return false; // already signed in

  const streak = getLocalStreak();
  return (streak.current || 0) >= 5;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Call this after the user completes a puzzle.
 *
 * @param {object} result
 *   puzzle_date  {string}  'YYYY-MM-DD'
 *   solved       {boolean}
 *   guesses_used {number}  1–6
 *   time_seconds {number}
 *   hints_used   {boolean}
 *
 * @param {function} onPromptSignUp
 *   Optional callback — called when streak >= 5 and user is anonymous.
 *   Use this to show your "save your streak" modal.
 */
async function recordResult(result, onPromptSignUp) {
  // Always save locally first
  saveLocalResult(result);

  // If authenticated, also save to DB
  const user = await getUser();
  if (user) {
    await saveDbResult(result);
  }

  // Check if we should prompt sign-up
  if (onPromptSignUp && await shouldPromptSignUp()) {
    onPromptSignUp(getLocalStreak());
  }
}

/**
 * Call once on page load to handle the post-OAuth redirect.
 * Detects if the user just signed in and migrates local data.
 */
async function handleAuthRedirect() {
  // Supabase automatically parses the URL hash after OAuth redirect
  const { data } = await _sb.auth.getSession();
  if (data?.session) {
    await migrateLocalHistoryToDb();
  }

  // Subscribe to future auth changes
  _sb.auth.onAuthStateChange(async (event) => {
    if (event === 'SIGNED_IN') {
      await migrateLocalHistoryToDb();
    }
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────
// In vanilla JS, just use these functions directly in your main script.
// No import/export needed — include this file via <script> tag.

window.Filmoji = {
  recordResult,
  handleAuthRedirect,
  signInWithGoogle,
  signOut,
  getUser,
  getStreak,
  getLeaderboard,
  getUserHistory,
  shouldPromptSignUp,
  getLocalHistory,
  getLocalStreak,
};
