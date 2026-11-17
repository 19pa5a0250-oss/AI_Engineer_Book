(() => {
  "use strict";
  const data = window.HUB_DATA;
  const legacyKeys = { done: "aiHub.v2.completed", saved: "aiHub.v2.bookmarks", theme: "aiHub.theme", recent: "aiHub.v2.recent" };
  const accountsKey = "aiHub.accounts.v1";
  const progressCachePrefix = "aiHub.progress.v1.";
  const validViews = new Set(["dashboard", "curriculum", "supplementary", "interviews", "glossary", "revision", "lesson"]);
  const lessonIds = new Set(data.allLessons.map(item => item.id));
  const courseLessonIds = new Set(data.allLessons.filter(item => item.kind === "course").map(item => item.id));
  let accounts = [];
  let activeAccount = null;
  let supabaseClient = null;
  let statusTimer;
  let cloudSaveTimer;
  let pendingCloudSave = null;
  let cloudSyncPromise = Promise.resolve();
  const state = {
    done: new Set(), saved: new Set(), recent: [], theme: "light",
    view: "dashboard", current: null, search: "", filter: "all", quick: false,
    expandedSections: new Set(), noteDismissed: false
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const save = () => {
    if (!activeAccount) return false;
    const index = accounts.findIndex(account => account.id === activeAccount.id);
    if (index < 0) {
      showAppStatus("This profile is no longer available in this browser. Sign in again to continue.", "error");
      return false;
    }
    const updatedAt = new Date().toISOString();
    const updated = { ...activeAccount, state: snapshotState(), updatedAt };
    const nextAccounts = accounts.slice();
    nextAccounts[index] = updated;
    try {
      localStorage.setItem(accountsKey, JSON.stringify(nextAccounts));
      accounts = nextAccounts;
      activeAccount = updated;
    } catch (error) {
      showAppStatus(`Progress could not be cached in this browser: ${error.message}`, "error");
      return false;
    }
    queueCloudSave(updated.state, updatedAt);
    return true;
  };
  function showAuthStatus(message, kind = "info") {
    const status = $("#auth-status");
    status.textContent = message;
    status.dataset.kind = kind;
    status.hidden = false;
  }
  function showAppStatus(message, kind = "info") {
    const status = $("#app-status");
    status.textContent = message;
    status.dataset.kind = kind;
    status.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.hidden = true; }, 7000);
  }
  function snapshotState() {
    return {
      completed: [...state.done],
      bookmarks: [...state.saved],
      recent: state.recent.slice(0, 6),
      theme: state.theme,
      view: state.view,
      current: state.current,
      search: state.search,
      filter: state.filter,
      quick: state.quick,
      expandedSections: [...state.expandedSections],
      noteDismissed: state.noteDismissed
    };
  }
  function createSupabaseClient() {
    const config = window.SUPABASE_CONFIG;
    if (!config || typeof config.url !== "string" || !config.url ||
        typeof config.publishableKey !== "string" || !config.publishableKey ||
        config.url.includes("YOUR_PROJECT_ID") || config.publishableKey.includes("YOUR_SUPABASE")) {
      throw new Error("Supabase is not configured. Add your project URL and publishable key to supabase-config.js, then run supabase-schema.sql.");
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("The Supabase client could not load. Check your internet connection and reload the page.");
    }
    const projectUrl = new URL(config.url);
    if (projectUrl.protocol !== "https:" && projectUrl.hostname !== "localhost" && projectUrl.hostname !== "127.0.0.1") {
      throw new Error("The Supabase project URL must use HTTPS.");
    }
    return window.supabase.createClient(config.url, config.publishableKey, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
    });
  }
  function writeLocalAccounts() {
    try {
      localStorage.setItem(accountsKey, JSON.stringify(accounts));
      return true;
    } catch (error) {
      showAppStatus(`Local progress cache could not be saved: ${error.message}`, "error");
      return false;
    }
  }
  function progressCacheKey(userId) {
    return `${progressCachePrefix}${userId}`;
  }
  function readProgressCache(userId) {
    const raw = localStorage.getItem(progressCacheKey(userId));
    if (!raw) return null;
    try {
      const cached = JSON.parse(raw);
      if (!cached || !cached.state || typeof cached.updatedAt !== "string" || typeof cached.pending !== "boolean") {
        throw new Error("Invalid cached progress format.");
      }
      return cached;
    } catch (error) {
      showAppStatus(`A local progress cache could not be read: ${error.message}`, "error");
      return null;
    }
  }
  function writeProgressCache(userId, progress, updatedAt, pending) {
    try {
      localStorage.setItem(progressCacheKey(userId), JSON.stringify({ state: progress, updatedAt, pending }));
      return true;
    } catch (error) {
      showAppStatus(`Local progress cache could not be saved: ${error.message}`, "error");
      return false;
    }
  }
  function queueCloudSave(progress, updatedAt) {
    if (!supabaseClient || !activeAccount) return;
    pendingCloudSave = { userId: activeAccount.id, progress, updatedAt };
    writeProgressCache(activeAccount.id, progress, updatedAt, true);
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(() => {
      const queued = pendingCloudSave;
      pendingCloudSave = null;
      if (queued) void syncProgress(queued);
    }, 650);
  }
  function syncProgress(queued) {
    const operation = cloudSyncPromise.then(() => syncProgressNow(queued));
    cloudSyncPromise = operation;
    return operation;
  }
  async function syncProgressNow(queued) {
    if (!supabaseClient) return false;
    try {
      const { error } = await supabaseClient.from("user_progress").upsert({
        user_id: queued.userId,
        state: queued.progress,
        updated_at: queued.updatedAt
      }, { onConflict: "user_id" });
      if (error) throw new Error(error.message);
      const cached = readProgressCache(queued.userId);
      if (cached && cached.updatedAt === queued.updatedAt) {
        writeProgressCache(queued.userId, queued.progress, queued.updatedAt, false);
      }
      if (activeAccount && activeAccount.id === queued.userId && activeAccount.updatedAt === queued.updatedAt) {
        activeAccount = { ...activeAccount, cloudSyncedAt: queued.updatedAt };
        accounts = accounts.map(account => account.id === activeAccount.id ? activeAccount : account);
        writeLocalAccounts();
      }
      return true;
    } catch (error) {
      if (activeAccount && activeAccount.id === queued.userId) {
        showAppStatus(`Progress is saved on this device but could not sync to Supabase: ${error.message}`, "error");
      }
      return false;
    }
  }
  async function flushCloudSave() {
    clearTimeout(cloudSaveTimer);
    const queued = pendingCloudSave;
    pendingCloudSave = null;
    return queued ? syncProgress(queued) : cloudSyncPromise;
  }
  async function loadCloudProgress(user) {
    try {
      const { data: row, error } = await supabaseClient
        .from("user_progress")
        .select("state, updated_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!activeAccount || activeAccount.id !== user.id) return;
      const cached = readProgressCache(user.id);
      const localProgress = activeAccount.state || emptySnapshot();
      const localTimestamp = (cached && cached.updatedAt) || activeAccount.updatedAt || "";
      if (row) {
        const cloudTime = Date.parse(row.updated_at || "");
        const localTime = Date.parse(localTimestamp);
        const hasUnsyncedLocalState = (cached && cached.pending) ||
          (activeAccount.updatedAt && activeAccount.updatedAt !== activeAccount.cloudSyncedAt);
        const localIsNewer = hasUnsyncedLocalState && localTime &&
          (!Number.isFinite(cloudTime) || localTime > cloudTime);
        if (localIsNewer) {
          const progress = cached && cached.pending ? cached.state : localProgress;
          restoreAccountState({ state: progress });
          queueCloudSave(snapshotState(), activeAccount.updatedAt || (cached && cached.updatedAt));
          return;
        }
        restoreAccountState({ state: row.state });
        const timestamp = row.updated_at || new Date().toISOString();
        activeAccount = { ...activeAccount, state: row.state, updatedAt: timestamp, cloudSyncedAt: timestamp };
        accounts = accounts.map(account => account.id === activeAccount.id ? activeAccount : account);
        writeLocalAccounts();
        writeProgressCache(user.id, row.state, timestamp, false);
        return;
      }
      const progress = cached && cached.pending ? cached.state : localProgress;
      const timestamp = activeAccount.updatedAt || (cached && cached.updatedAt) || new Date().toISOString();
      restoreAccountState({ state: progress });
      queueCloudSave(snapshotState(), timestamp);
    } catch (error) {
      if (!activeAccount || activeAccount.id !== user.id) return;
      const cached = readProgressCache(user.id);
      const fallback = cached && cached.pending ? cached.state : (activeAccount.state || emptySnapshot());
      restoreAccountState({ state: fallback });
      showAppStatus(`Could not load cloud progress; using this device's cached copy. ${error.message}`, "error");
    }
  }
  function emptySnapshot() {
    return { completed: [], bookmarks: [], recent: [], theme: "light", view: "dashboard", current: null, search: "", filter: "all", quick: false, expandedSections: [], noteDismissed: false };
  }
  function readAccounts() {
    const raw = localStorage.getItem(accountsKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some(account =>
      !account || typeof account.id !== "string" || typeof account.name !== "string" ||
      typeof account.email !== "string" || !account.state
    )) throw new Error("Saved local profiles are unreadable. Do not clear browser data until you have a JSON backup.");
    return parsed.map(account => ({
      id: account.id,
      name: account.name,
      email: account.email.trim().toLowerCase(),
      ...(typeof account.createdAt === "string" ? { createdAt: account.createdAt } : {}),
      ...(typeof account.updatedAt === "string" ? { updatedAt: account.updatedAt } : {}),
      ...(typeof account.cloudSyncedAt === "string" ? { cloudSyncedAt: account.cloudSyncedAt } : {}),
      state: account.state
    }));
  }
  function readLegacyArray(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("Previous learning progress could not be migrated. Download or preserve your browser data before continuing.");
    return value;
  }
  function initialAccountState() {
    if (accounts.length) return emptySnapshot();
    const legacyDone = readLegacyArray(legacyKeys.done);
    const legacySaved = readLegacyArray(legacyKeys.saved);
    const legacyRecent = readLegacyArray(legacyKeys.recent);
    return {
      ...emptySnapshot(),
      completed: legacyDone.filter(id => typeof id === "string" && courseLessonIds.has(id)),
      bookmarks: legacySaved.filter(id => typeof id === "string" && lessonIds.has(id)),
      recent: legacyRecent.filter(id => typeof id === "string" && lessonIds.has(id)).slice(0, 6),
      theme: localStorage.getItem(legacyKeys.theme) === "dark" ? "dark" : "light"
    };
  }
  function restoreAccountState(account) {
    const stored = account.state;
    if (!Array.isArray(stored.completed) || !Array.isArray(stored.bookmarks) || !Array.isArray(stored.recent)) {
      throw new Error("This profile's saved progress is incomplete. Restore it from a valid JSON backup.");
    }
    state.done = new Set(stored.completed.filter(id => typeof id === "string" && courseLessonIds.has(id)));
    state.saved = new Set(stored.bookmarks.filter(id => typeof id === "string" && lessonIds.has(id)));
    state.recent = stored.recent.filter(id => typeof id === "string" && lessonIds.has(id)).slice(0, 6);
    state.theme = stored.theme === "dark" ? "dark" : "light";
    state.view = validViews.has(stored.view) ? stored.view : "dashboard";
    state.current = typeof stored.current === "string" && lessonIds.has(stored.current) ? stored.current : null;
    if (state.view === "lesson" && !state.current) state.view = "dashboard";
    state.search = typeof stored.search === "string" ? stored.search.slice(0, 200) : "";
    state.filter = stored.filter === "Suggested additions" || Object.prototype.hasOwnProperty.call(data.extras, stored.filter) ? stored.filter : "all";
    state.quick = stored.quick === true;
    state.expandedSections = new Set(Array.isArray(stored.expandedSections) ? stored.expandedSections.filter(number => typeof number === "string") : []);
    state.noteDismissed = stored.noteDismissed === true;
  }
  function renderAuth() {
    $("#auth-screen").hidden = false;
    $("#app-shell").hidden = true;
  }
  function setAuthMode(mode) {
    const registering = mode === "register";
    $("#auth-name-field").hidden = !registering;
    $("#auth-name").required = registering;
    $("#auth-password").autocomplete = registering ? "new-password" : "current-password";
    $("#auth-register-tab").classList.toggle("active", registering);
    $("#auth-login-tab").classList.toggle("active", !registering);
    $("#auth-register-tab").setAttribute("aria-pressed", String(registering));
    $("#auth-login-tab").setAttribute("aria-pressed", String(!registering));
    $("#auth-submit").textContent = registering ? "Create account" : "Sign in";
    $("#auth-hint").textContent = registering
      ? "Use at least 8 characters. Your account is managed securely by Supabase."
      : "Sign in with the email and password used to create your account.";
    $("#auth-status").hidden = true;
    $("#auth-form").dataset.mode = mode;
  }
  function startSession(user) {
    const email = String(user.email || "").trim().toLowerCase();
    const existing = accounts.find(account => account.id === user.id);
    const legacy = accounts.find(account => account.id !== user.id && account.email === email);
    const name = String((user.user_metadata && user.user_metadata.display_name) ||
      (existing && existing.name) || (legacy && legacy.name) || email.split("@")[0] || "Learner").slice(0, 60);
    const progress = (existing && existing.state) || (legacy && legacy.state) ||
      (accounts.length ? emptySnapshot() : initialAccountState());
    const savedTimestamp = (existing && existing.updatedAt) || (legacy && legacy.updatedAt);
    const timestamp = savedTimestamp || new Date().toISOString();
    const syncedTimestamp = (existing && existing.cloudSyncedAt) || (legacy && legacy.cloudSyncedAt) ||
      (!savedTimestamp ? timestamp : undefined);
    activeAccount = {
      id: user.id, name, email,
      createdAt: (existing && existing.createdAt) || (legacy && legacy.createdAt) || new Date().toISOString(),
      updatedAt: timestamp,
      ...(syncedTimestamp ? { cloudSyncedAt: syncedTimestamp } : {}),
      state: progress
    };
    accounts = accounts.filter(account => account.id !== user.id && account.email !== email);
    accounts.push(activeAccount);
    writeLocalAccounts();
    restoreAccountState(activeAccount);
    $("#auth-password").value = "";
    $("#profile-name").textContent = name;
    $("#profile-avatar").textContent = name.trim().charAt(0).toUpperCase() || "A";
    $("#auth-screen").hidden = true;
    $("#app-shell").hidden = false;
    closeSidebar();
    $(".access-note").hidden = state.noteDismissed;
    $("#lesson-search").value = state.search;
    document.body.classList.toggle("dark", state.theme === "dark");
    document.body.classList.toggle("quick-mode", state.quick);
    $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === state.view));
    toggleThemeIcons();
    render();
    void loadCloudProgress(user).then(() => {
      if (activeAccount && activeAccount.id === user.id) {
        $(".access-note").hidden = state.noteDismissed;
        $("#lesson-search").value = state.search;
        document.body.classList.toggle("dark", state.theme === "dark");
        document.body.classList.toggle("quick-mode", state.quick);
        $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === state.view));
        toggleThemeIcons();
        render();
      }
    }).catch(error => {
      if (activeAccount && activeAccount.id === user.id) {
        showAppStatus(`Could not load cloud progress: ${error.message}`, "error");
      }
    });
  }
  async function handleAuthSubmit(event) {
    event.preventDefault();
    const registering = $("#auth-form").dataset.mode === "register";
    const name = $("#auth-name").value.trim();
    const email = $("#auth-email").value.trim().toLowerCase();
    const password = $("#auth-password").value;
    $("#auth-status").hidden = true;
    try {
      if (!supabaseClient) throw new Error("Supabase is not configured. Add your project URL and publishable key to supabase-config.js.");
      if (registering) {
        if (name.length < 1 || name.length > 60) throw new Error("Enter a display name between 1 and 60 characters.");
        if (password.length < 8) throw new Error("Choose a password with at least 8 characters.");
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name },
            emailRedirectTo: `${window.location.origin}${window.location.pathname}`
          }
        });
        if (error) throw new Error(error.message);
        if (!data.session) {
          showAuthStatus("Registration started. Check your email and confirm the account, then return here to sign in.", "info");
          return;
        }
        startSession(data.user);
      } else {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
        startSession(data.user);
      }
    } catch (error) {
      showAuthStatus(error.message || "The profile could not be opened.", "error");
    }
  }
  function clearSession() {
    clearTimeout(cloudSaveTimer);
    pendingCloudSave = null;
    activeAccount = null;
    state.done.clear();
    state.saved.clear();
    state.recent = [];
    state.theme = "light";
    state.view = "dashboard";
    state.current = null;
    state.search = "";
    state.filter = "all";
    state.quick = false;
    state.expandedSections.clear();
    state.noteDismissed = false;
    document.body.classList.remove("dark", "quick-mode");
    $("#lesson-search").value = "";
    $("#auth-password").value = "";
    $("#app-shell").hidden = true;
    closeSidebar();
    renderAuth();
    setAuthMode("login");
  }
  async function logout() {
    if (!save()) return;
    let synced;
    try {
      synced = await flushCloudSave();
      const { error } = await supabaseClient.auth.signOut();
      if (error) throw new Error(error.message);
    } catch (error) {
      showAppStatus(`Could not sign out on this device: ${error.message}`, "error");
      return;
    }
    clearSession();
    if (!synced) showAuthStatus("Signed out. Your latest progress remains in this browser and will retry syncing when you sign in again.", "error");
  }
  function downloadBackup() {
    if (!activeAccount) return;
    const backup = {
      format: "ai-engineer-learning-hub-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      account: { name: activeAccount.name, email: activeAccount.email },
      state: snapshotState()
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const fileName = activeAccount.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "user";
    link.href = url;
    link.download = `ai-engineer-learning-hub-${fileName}-backup.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeSidebar();
    showAppStatus("JSON backup downloaded. Download a fresh copy after future study sessions.");
  }
  function validateBackup(backup) {
    if (!backup || backup.format !== "ai-engineer-learning-hub-backup" || backup.version !== 1) {
      throw new Error("This is not a supported AI Engineer Learning Hub backup.");
    }
    if (!activeAccount || !backup.account || typeof backup.account.email !== "string" ||
        backup.account.email.trim().toLowerCase() !== activeAccount.email) {
      throw new Error("This backup belongs to a different email. Sign in to the matching local profile before restoring it.");
    }
    const stored = backup.state;
    if (!stored || !Array.isArray(stored.completed) || !Array.isArray(stored.bookmarks) || !Array.isArray(stored.recent) ||
        !stored.completed.every(id => typeof id === "string" && courseLessonIds.has(id)) ||
        !stored.bookmarks.every(id => typeof id === "string" && lessonIds.has(id)) ||
        !stored.recent.every(id => typeof id === "string" && lessonIds.has(id)) ||
        !Array.isArray(stored.expandedSections) || !stored.expandedSections.every(number => typeof number === "string") ||
        typeof stored.noteDismissed !== "boolean") {
      throw new Error("The backup contains invalid or unsupported lesson data.");
    }
    if (stored.theme !== "light" && stored.theme !== "dark") throw new Error("The backup has an invalid theme setting.");
    if (!validViews.has(stored.view) || (stored.current !== null && (typeof stored.current !== "string" || !lessonIds.has(stored.current)))) {
      throw new Error("The backup has an invalid last-view setting.");
    }
    if (typeof stored.search !== "string" || typeof stored.quick !== "boolean" ||
        !(stored.filter === "all" || stored.filter === "Suggested additions" || Object.prototype.hasOwnProperty.call(data.extras, stored.filter))) {
      throw new Error("The backup has invalid view preferences.");
    }
    return stored;
  }
  async function restoreBackup(file) {
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("Backup files must be smaller than 1 MB.");
      let backup;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        throw new Error("The selected file is not valid JSON.");
      }
      const restored = validateBackup(backup);
      state.done = new Set([...state.done, ...restored.completed]);
      state.saved = new Set([...state.saved, ...restored.bookmarks]);
      state.recent = [...new Set([...restored.recent, ...state.recent])].slice(0, 6);
      state.theme = restored.theme;
      state.view = restored.view;
      state.current = restored.current;
      if (state.view === "lesson" && !state.current) state.view = "dashboard";
      state.search = restored.search.slice(0, 200);
      state.filter = restored.filter;
      state.quick = restored.quick;
      state.expandedSections = new Set(restored.expandedSections);
      state.noteDismissed = restored.noteDismissed;
      document.body.classList.toggle("dark", state.theme === "dark");
      document.body.classList.toggle("quick-mode", state.quick);
      $(".access-note").hidden = state.noteDismissed;
      $("#lesson-search").value = state.search;
      const saved = save();
      toggleThemeIcons();
      render();
      if (saved) showAppStatus("Backup restored and merged with this profile's existing progress.");
    } catch (error) {
      showAppStatus(error.message || "The backup could not be restored.", "error");
    } finally {
      $("#backup-import").value = "";
      closeSidebar();
    }
  }
  const lessonById = id => data.allLessons.find(item => item.id === id);
  const courseLessons = data.allLessons.filter(item => item.kind === "course");
  const supplementaryLessons = data.allLessons.filter(item => item.kind !== "course");
  const orderedSections = [
    ...data.courseSections.map(item => ({ ...item, entryType: "known" })),
    ...data.missingSections.map(item => ({ ...item, entryType: "missing" }))
  ].sort((a, b) => Number.parseInt(a.number, 10) - Number.parseInt(b.number, 10));
  const pct = (done, total) => total ? Math.round(done / total * 100) : 0;
  const currentIndex = () => courseLessons.findIndex(item => item.id === state.current);

  function setView(view) {
    state.view = view;
    state.search = "";
    $("#lesson-search").value = "";
    $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === view));
    save();
    render();
    closeSidebar();
  }
  function openLesson(id) {
    const lesson = lessonById(id);
    if (!lesson) return;
    state.current = id;
    state.view = "lesson";
    state.search = "";
    $("#lesson-search").value = "";
    document.body.classList.remove("quick-mode");
    state.recent = [id, ...state.recent.filter(item => item !== id)].slice(0, 6);
    save();
    $$(".nav-item").forEach(button => button.classList.remove("active"));
    render();
    closeSidebar();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function showBreadcrumb(label) { $("#breadcrumbs").innerHTML = `Learning space <span>/</span> ${escapeHtml(label)}`; }
  function progressFor(section) {
    const completed = section.lessons.filter(lesson => state.done.has(lesson.id)).length;
    return { completed, total: section.lessons.length, percent: pct(completed, section.lessons.length) };
  }
  function renderOutline() {
    const outline = $("#course-outline");
    outline.innerHTML = orderedSections.map((section, index) => {
      const moduleLabel = section.entryType === "known" &&
        (index === 0 || orderedSections[index - 1].module !== section.module)
        ? `<div class="nav-label module-outline-label">${escapeHtml(section.module)}</div>` : "";
      if (section.entryType === "missing") return `<div class="unverified-label">§ ${escapeHtml(section.number)} · ${escapeHtml(section.title)}</div>`;
      const progress = progressFor(section);
      const expanded = state.expandedSections.has(String(section.number));
      return `${moduleLabel}<div class="outline-section ${expanded ? "open" : ""}" data-section="${section.number}">
        <button class="outline-head" aria-expanded="${expanded}">
          <span class="outline-caret">▶</span><span class="outline-title">${escapeHtml(section.title)}</span>
          <span class="outline-count">${progress.total ? `${progress.completed}/${progress.total}` : "?"}</span>
        </button>
        ${progress.total ? `<div class="section-progress"><span style="width:${progress.percent}%"></span></div>` : ""}
        ${progress.total ? "" : `<div class="unverified-label">Lesson titles not available in the supplied brief.</div>`}
        <div class="outline-lessons">${section.lessons.map(lesson => `<button class="outline-lesson ${state.current === lesson.id ? "selected" : ""}" data-lesson="${lesson.id}">
          <span class="mini-check ${state.done.has(lesson.id) ? "done" : ""}">${state.done.has(lesson.id) ? "✓" : ""}</span>${escapeHtml(lesson.title)}
        </button>`).join("")}</div>
      </div>`;
    }).join("");
    $$(".outline-head", outline).forEach(button => button.addEventListener("click", () => {
      const parent = button.closest(".outline-section");
      parent.classList.toggle("open");
      const expanded = parent.classList.contains("open");
      button.setAttribute("aria-expanded", expanded);
      if (expanded) state.expandedSections.add(parent.dataset.section);
      else state.expandedSections.delete(parent.dataset.section);
      save();
    }));
    $$(".outline-lesson", outline).forEach(button => button.addEventListener("click", () => openLesson(button.dataset.lesson)));
  }
  function sectionCoverage() {
    return data.courseSections.map(section => {
      const p = progressFor(section);
      return { title: section.title, percent: p.percent, total: p.total, completed: p.completed };
    }).filter(section => section.total);
  }
  function stat(label, value, note, icon) {
    return `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></article>`;
  }
  function renderDashboard() {
    showBreadcrumb("Dashboard");
    const total = courseLessons.length, completed = courseLessons.filter(item => state.done.has(item.id)).length;
    const bookmarked = data.allLessons.filter(item => state.saved.has(item.id));
    const recent = state.recent.map(lessonById).filter(Boolean);
    const sections = sectionCoverage();
    const avg = pct(completed, total);
    $("#page-content").innerHTML = `
      <div class="page-heading"><div><div class="eyebrow">YOUR PERSONAL STUDY SPACE</div><h1>AI Engineer Learning Hub</h1>
      <p>Your complete learning and technical reference platform. Learn in small steps, keep track of progress, and return to what matters.</p></div>
      <div class="heading-actions"><button class="button" data-view="curriculum">Browse curriculum <span>↗</span></button></div></div>
      <div class="stats-grid">
        ${stat("Course sections", data.courseMeta.sectionCount, `Transcript duration: ${data.courseMeta.duration}`, "☷")}
        ${stat("Listed course items", total, `Includes repeated titles, quizzes, and practice items`, "▤")}
        ${stat("Completed", completed, `${total - completed} listed items remaining`, "✓")}
        ${stat("Remaining listed items", total - completed, `Source header reports ${data.courseMeta.reportedLectureCount} lectures`, "↗")}
      </div>
      <div class="dashboard-grid">
        <section class="panel"><div class="panel-heading"><h2>Your progress</h2><span class="muted">${completed} of ${total} listed items</span></div>
          <div class="progress-panel"><div class="ring" style="--progress:${avg}%"><div class="ring-inner">${avg}%</div></div>
          <div class="progress-copy"><h3>${avg ? "Nice momentum." : "A good place to begin."}</h3><p>${avg ? `You have completed ${completed} listed course items. Keep your streak manageable and revisit difficult concepts.` : "Choose any lesson from the course outline. Your completion and bookmarks are saved locally in this browser."}</p></div></div>
          <div style="height:17px"></div><div class="panel-heading"><h3>Learning roadmap</h3><span class="muted">A suggested path</span></div>
          <div class="roadmap">${["AI fundamentals","Python","NLP","Machine learning","Deep learning","Generative AI","LLMs","RAG","AI agents","Projects"].map((item, i) => `${i ? `<span class="roadmap-arrow">→</span>` : ""}<span class="roadmap-step ${i < 2 ? "active" : ""}">${item}</span>`).join("")}</div>
        </section>
        <section class="panel"><div class="panel-heading"><h2>Section progress</h2><button class="text-button" data-view="curriculum">View all</button></div>
          <div class="track-list">${sections.slice(0, 6).map(item => `<div class="track-row"><span>${escapeHtml(item.title.replace(/^.*– /, ""))}</span><div class="track-bar"><span style="width:${item.percent}%"></span></div><small>${item.percent}%</small></div>`).join("")}</div>
        </section>
      </div>
      <div class="dashboard-lower">
        <section class="panel"><div class="panel-heading"><h2>Recently studied</h2><span class="muted">This device</span></div>
          ${recent.length ? recent.map(item => `<button class="list-row result-button" data-lesson="${item.id}" style="width:100%;border:0;background:transparent;text-align:left;cursor:pointer"><span class="tiny-icon">↗</span><span class="list-row-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.sectionTitle)}</small></span><span class="muted">›</span></button>`).join("") : `<div class="empty-state">Lessons you open will show up here.</div>`}
        </section>
        <section class="panel"><div class="panel-heading"><h2>Bookmarked concepts</h2><button class="text-button" data-view="supplementary">Explore reference</button></div>
          ${bookmarked.length ? bookmarked.slice(0, 4).map(item => `<button class="list-row result-button" data-lesson="${item.id}" style="width:100%;border:0;background:transparent;text-align:left;cursor:pointer"><span class="tiny-icon">☆</span><span class="list-row-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.sectionTitle)}</small></span><span class="muted">›</span></button>`).join("") : `<div class="empty-state">Bookmark a lesson to keep it close at hand.</div>`}
        </section>
      </div>`;
    $$(".result-button").forEach(button => button.addEventListener("click", () => openLesson(button.dataset.lesson)));
  }

  function renderCurriculum() {
    showBreadcrumb("Course curriculum");
    $("#page-content").innerHTML = `<div class="page-heading"><div><div class="eyebrow">ORIGINAL COURSE OUTLINE</div><h1>Course curriculum</h1>
      <p>Imported all ${data.courseMeta.sectionCount} sections and every displayed lecture, quiz, and practice title from your supplied transcript; repeated titles are retained. The source header reports ${data.courseMeta.reportedLectureCount} lectures, while its listed entries total ${data.courseMeta.listedItemCount}. Supplementary ideas are kept separate.</p></div></div>
      <div class="curriculum-grid">${orderedSections.map((section, index) => {
        if (section.entryType === "missing") return `<article class="curriculum-card missing-card"><div class="curriculum-card-head"><span class="section-index">${escapeHtml(section.number)}</span><div class="curriculum-title"><h3>${escapeHtml(section.title)}</h3><p>Curriculum gap · not included in lesson counts</p></div></div><p class="missing-explanation">${escapeHtml(section.message)}</p></article>`;
        const progress = progressFor(section);
        const empty = !section.lessons.length;
        const moduleHeading = index === 0 || orderedSections[index - 1].module !== section.module
          ? `<div class="module-heading">${escapeHtml(section.module)}</div>` : "";
        return `${moduleHeading}<article class="curriculum-card ${empty ? "missing-card" : ""}"><div class="curriculum-card-head">
          <span class="section-index">${section.number}</span><div class="curriculum-title"><h3>${escapeHtml(section.title)}</h3><p>${empty ? "Section title supplied; original lessons unavailable" : `${progress.total} listed items · ${progress.completed} completed`}</p></div>
          ${progress.total ? `<div class="curriculum-progress"><div><span style="width:${progress.percent}%"></span></div><small>${progress.percent}%</small></div>` : ""}
          </div>${empty ? `<p class="missing-explanation">The brief asks to retrieve the original lesson list, but it was not included. No lesson titles have been invented.</p>` : `<div class="curriculum-lessons">${section.lessons.map(lesson => `<button class="curriculum-lesson" data-lesson="${lesson.id}"><span class="mini-check ${state.done.has(lesson.id) ? "done" : ""}">${state.done.has(lesson.id) ? "✓" : ""}</span>${escapeHtml(lesson.title)}</button>`).join("")}</div>`}
          ${section.note ? `<p class="missing-explanation">${escapeHtml(section.note)}</p>` : ""}
        </article>`;
      }).join("")}</div>`;
    $$(".curriculum-lesson").forEach(button => button.addEventListener("click", () => openLesson(button.dataset.lesson)));
  }

  function contentFor(item) {
    const study = item.study;
    if (!study) throw new Error(`Missing study data for lesson ${item.id}`);
    return {
      summary: item.summary,
      why: study.why,
      steps: study.steps,
      examples: study.examples,
      code: getCode(item),
      q: study.interview,
      exercises: study.exercises,
      revision: study.revision,
      advantages: study.advantages,
      limitations: study.limitations,
      related: study.related,
      extras: item.kind !== "course"
    };
  }
  function getCode(item) {
    const lower = item.title.toLowerCase();
    const python = source => ({ language: "Python", source });
    const pseudocode = source => ({ language: "Python-like pseudocode", source });
    if (lower.includes("using methods")) return python(`values = [3, 1, 4]\nvalues.append(2)  # Add one item.\nvalues.sort()      # Sort the list in place.\nprint(values)       # [1, 2, 3, 4]`);
    if (lower.includes("tuple")) return python(`point = (4, 7)\nx, y = point  # Unpack the two values.\nprint(x + y)   # 11`);
    if (lower.includes("dictionary")) return python(`profile = {"name": "Ari", "active": True}\n# get() safely handles a missing optional key.\nteam = profile.get("team", "unassigned")\nprint(team)`);
    if (lower.includes("list") || lower.includes("sequence") || lower.includes("comprehension")) return python(`values = [3, 1, 4, 1, 5]\n# Build a new list; the original stays unchanged.\nlarge_values = [value for value in values if value > 2]\nprint(large_values)  # [3, 4, 5]`);
    if (lower.includes("variable") || lower.includes("data type") || lower.includes("string")) return python(`name = "Ari"\nlessons_done = 3\nis_learning = True\n\nprint(f"{name} completed {lessons_done} lessons.")`);
    if (lower.includes("function") || lower.includes("lambda")) return python(`def normalize_label(text):\n    """Return a trimmed, lowercase label."""\n    return text.strip().lower()\n\nprint(normalize_label("  AI  "))`);
    if (lower.includes("api")) return python(`import json\nfrom urllib.request import Request, urlopen\n\nrequest = Request(\n    "https://example.com/api/items",\n    headers={"Accept": "application/json"},\n)\nwith urlopen(request, timeout=10) as response:\n    data = json.load(response)\nprint(data)`);
    if (lower.includes("supervised") || lower.includes("machine learning") || lower.includes("classification") || lower.includes("regression") || lower.includes("clustering")) return python(`# A tiny nearest-neighbor classifier using only Python.\ntraining = [(1.0, "low"), (4.0, "high")]\n\ndef predict(value):\n    closest = min(training, key=lambda row: abs(row[0] - value))\n    return closest[1]\n\nprint(predict(3.2))  # high`);
    if (lower.includes("prompt") || lower.includes("generative") || lower.includes("llm")) return python(`question = "What does the policy say about refunds?"\nevidence = "Refunds are available within 30 days."\n\nprompt = f"""Answer using only this evidence.\nIf it is insufficient, say so.\n\nQuestion: {question}\nEvidence: {evidence}"""\nprint(prompt)`);
    if (lower.includes("embedding") || lower.includes("vector") || lower.includes("similarity")) return python(`# Compare vectors only after choosing a suitable model.\nfrom math import sqrt\n\ndef cosine_similarity(a, b):\n    dot = sum(x * y for x, y in zip(a, b))\n    norm_a = sqrt(sum(x * x for x in a))\n    norm_b = sqrt(sum(y * y for y in b))\n    return dot / (norm_a * norm_b) if norm_a and norm_b else 0.0`);

    switch (item.study.domain) {
      case "Python":
        return python(`def summarize(values):\n    count = len(values)\n    total = sum(values)\n    return {"count": count, "mean": total / count if count else 0}\n\nprint(summarize([2, 4, 6]))`);
      case "NLP":
        return python(`text = "AI systems need careful evaluation."\ntokens = [word.strip(".,!?").lower() for word in text.split()]\nprint(tokens)`);
      case "Deep learning":
        return pseudocode(`# Training-step outline (framework-neutral)\npredictions = model(batch)\nloss = loss_function(predictions, labels)\nloss.backward()       # Compute gradients.\noptimizer.step()      # Update parameters.\noptimizer.zero_grad() # Clear gradients before the next step.`);
      case "Generative AI and LLMs":
        return python(`context = "The policy allows returns within 30 days."\nquestion = "When can I return an item?"\nprompt = f"Use this context only:\\n{context}\\nQuestion: {question}"\n# Verify the generated answer against the context.`);
      case "RAG and vector search":
        return pseudocode(`# Retrieval-augmented generation flow\nchunks = parse_and_split(permitted_documents)\nindex = embed_and_index(chunks)\nevidence = retrieve(index, question, user_permissions)\nanswer = generate(question, evidence)\nreturn answer_with_source_links(answer, evidence)`);
      case "AI agents":
        return pseudocode(`# Bounded agent loop\nfor step in range(max_steps):\n    action = model.choose_action(goal, allowed_tools)\n    validate_action(action)\n    result = run_tool(action)\n    if needs_human_approval(action):\n        break\n    goal = update_goal_state(goal, result)`);
      case "AI engineering":
        return python(`def handle_request(request):\n    validate_input(request)\n    result = call_model_with_timeout(request, timeout_seconds=10)\n    response = validate_output(result)\n    record_metrics(latency=True, usage=True)\n    return response`);
      case "Data and classical ML":
        return python(`# Keep the final test examples out of training.\nmodel.fit(train_features, train_labels)\npredictions = model.predict(test_features)\nscore = chosen_metric(test_labels, predictions)\nprint(f"Final test score: {score:.3f}")`);
      default:
        return pseudocode(`# Example workflow for ${item.title}\ninputs = collect_representative_inputs()\nresult = apply_method(inputs)\ncheck_result(result)\nreview_errors_and_limitations(result)`);
    }
  }
  function explainCodeLine(line) {
    const text = line.trim();
    if (!text) return "A blank line separates related statements for readability.";
    if (text.startsWith("#")) return "A comment for the reader; Python does not execute it.";
    if (text.startsWith("import ") || text.startsWith("from ")) return "Imports a module or selected name so the code can use its functionality.";
    if (text.startsWith("def ")) return "Defines a reusable function and names its input parameters.";
    if (text.startsWith("return ")) return "Returns a result to the function's caller.";
    if (text.startsWith("if ")) return "Checks a condition and chooses whether to execute the indented block.";
    if (text.startsWith("for ")) return "Begins iterating over values in the supplied iterable.";
    if (text.startsWith("print(")) return "Displays a value, useful here for making the result visible.";
    if (text.includes(".fit(")) return "Fits or trains the model using the supplied training examples.";
    if (text.includes(".predict(")) return "Asks the fitted model to produce predictions for the given inputs.";
    if (text.includes("raise_for_status")) return "Raises an error for an unsuccessful HTTP response instead of silently using it.";
    if (text.includes(".json()")) return "Decodes the response body as JSON data.";
    if (text.includes("=") && !text.includes("==")) return `Assigns the value on the right to ${text.split("=")[0].trim()} for later use.`;
    return "Evaluates this expression or calls the named operation; inspect its result and handle possible errors.";
  }
  function readerSection(id, title, body, extraClass = "") {
    return `<section id="${id}" class="reader-section ${extraClass}"><h2><span class="section-number">${id === "what" ? "01" : id === "why" ? "02" : id === "how" ? "03" : id === "examples" ? "04" : id === "code" ? "05" : id === "tradeoffs" ? "06" : id === "interview" ? "07" : "08"}</span>${title}</h2>${body}</section>`;
  }
  function renderLesson(item) {
    const doc = contentFor(item);
    const index = currentIndex();
    const prev = item.kind === "course" ? courseLessons[index - 1] : null;
    const next = item.kind === "course" ? courseLessons[index + 1] : null;
    const bookmarked = state.saved.has(item.id);
    const completed = state.done.has(item.id);
    showBreadcrumb(item.kind === "course" ? "Course curriculum" : "Technical reference");
    const sections = [
      readerSection("what", "What is it?", `<p>${escapeHtml(doc.summary)}</p>`),
      readerSection("why", "Why do we need it?", `<p>${escapeHtml(doc.why)}</p>`),
      readerSection("how", "How does it work?", `<ol>${doc.steps.map(step => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`),
      readerSection("examples", "Real-world examples", `<div class="example-grid">${doc.examples.map((example, i) => `<div class="example-card"><strong>Example ${i + 1}</strong><p>${escapeHtml(example)}</p></div>`).join("")}</div>`),
      doc.code ? readerSection("code", "Technical example", `<div class="code-block"><div class="code-head"><span>${escapeHtml(doc.code.language)} · illustrative example</span><button class="copy-button">Copy code</button></div><pre><code>${escapeHtml(doc.code.source)}</code></pre></div><details class="code-walkthrough"><summary>Read the code line by line</summary><ol>${doc.code.source.split("\n").map(line => `<li><code>${escapeHtml(line || " ")}</code><span>${escapeHtml(explainCodeLine(line))}</span></li>`).join("")}</ol></details><p style="margin-top:9px">These snippets illustrate the idea; connect them to real input validation, error handling, and tests before using them in an application.</p>`) : "",
      readerSection("tradeoffs", "Advantages, limitations & related ideas", `<h3>Advantages</h3><ul>${doc.advantages.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul><h3 style="margin-top:12px">Limitations</h3><ul>${doc.limitations.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul><p><strong>Related concepts:</strong> ${escapeHtml(doc.related.join(", "))}.</p>`),
      readerSection("interview", "Interview preparation", `<details open><summary>5 basic questions</summary>${doc.q.filter(x => x.tier === "Basic").map(q => `<div class="interview-item"><strong>${escapeHtml(q.q)}</strong><p>${escapeHtml(q.a)}</p></div>`).join("")}</details>
        <details><summary>5 intermediate questions</summary>${doc.q.filter(x => x.tier === "Intermediate").map(q => `<div class="interview-item"><strong>${escapeHtml(q.q)}</strong><p>${escapeHtml(q.a)}</p></div>`).join("")}</details>
        <details><summary>3 advanced scenario questions</summary>${doc.q.filter(x => x.tier === "Advanced").map(q => `<div class="interview-item"><strong>${escapeHtml(q.q)}</strong><p>${escapeHtml(q.a)}</p></div>`).join("")}</details>`),
      readerSection("revision", "Quick revision & practice", `<ul>${doc.revision.map(note => `<li>${escapeHtml(note)}</li>`).join("")}</ul><h3 style="margin:12px 0 5px">Try it</h3><ol>${doc.exercises.map(exercise => `<li>${escapeHtml(exercise)}</li>`).join("")}</ol>`)
    ].filter(Boolean).join("");
    $("#page-content").innerHTML = `<div class="lesson-layout">
      <article class="lesson-main">
        <div class="lesson-title-row"><div><div class="eyebrow">${item.kind === "course" ? `COURSE ITEM · ${escapeHtml(item.module)}` : item.kind === "suggested" ? "SUGGESTED ADDITION" : "SUPPLEMENTARY ORIGINAL NOTES"}</div><h1>${escapeHtml(item.title)}</h1>
          <div class="lesson-meta"><span>${escapeHtml(item.sectionTitle)}</span><span>·</span><span>Study notes</span>${doc.extras ? `<span class="pill">${item.kind === "suggested" ? "Suggested addition" : "Supplementary"}</span>` : ""}</div></div>
          <div class="heading-actions"><button class="button ${bookmarked ? "saved" : ""}" id="bookmark-button">${bookmarked ? "★ Saved" : "☆ Bookmark"}</button><button class="button ${completed ? "primary" : ""}" id="complete-button">${completed ? "✓ Completed" : "Mark complete"}</button></div>
        </div>
        ${sections}
        ${item.kind === "course" ? `<div class="lesson-nav">${prev ? `<button class="button" data-lesson="${prev.id}"><span class="muted">← Previous</span><span>${escapeHtml(prev.title)}</span></button>` : `<span></span>`}${next ? `<button class="button next" data-lesson="${next.id}"><span class="muted">Next →</span><span>${escapeHtml(next.title)}</span></button>` : ""}</div>` : ""}
      </article>
      <aside class="reader-aside"><div class="aside-card"><h3>On this page</h3><div class="toc-list">${[["what","What is it?"],["why","Why do we need it?"],["how","How does it work?"],["examples","Examples"],...(doc.code ? [["code","Technical example"]] : []),["tradeoffs","Advantages & limitations"],["interview","Interview prep"],["revision","Quick revision"]].map(([id, label]) => `<button data-scroll="${id}">${label}</button>`).join("")}</div></div>
        <div class="aside-card"><h3>Key reminder</h3><div class="key-note">Start from the problem. Define what success means, test the idea with relevant examples, and keep track of its limitations.</div></div></aside>
      </div>`;
    $("#bookmark-button").addEventListener("click", () => {
      state.saved.has(item.id) ? state.saved.delete(item.id) : state.saved.add(item.id);
      save(); render();
    });
    $("#complete-button").addEventListener("click", () => {
      state.done.has(item.id) ? state.done.delete(item.id) : state.done.add(item.id);
      save(); render();
    });
    $$("[data-scroll]").forEach(button => button.addEventListener("click", () => document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" })));
    $$(".lesson-nav [data-lesson]").forEach(button => button.addEventListener("click", () => openLesson(button.dataset.lesson)));
  }

  function renderSupplementary() {
    showBreadcrumb("Technical reference");
    const tracks = ["all", ...new Set(supplementaryLessons.map(item => item.track))];
    const filtered = supplementaryLessons.filter(item => state.filter === "all" || item.track === state.filter);
    $("#page-content").innerHTML = `<div class="page-heading"><div><div class="eyebrow">ADDITIONAL LEARNING NOTES</div><h1>Technical reference</h1>
      <p>Original supplementary notes and proposed website additions. The course transcript is separate; suggested ideas are explicitly labeled and never counted as course lessons.</p></div></div>
      <div class="filter-row">${tracks.map(track => `<button class="filter-chip ${track === state.filter ? "active" : ""}" data-filter="${escapeHtml(track)}">${track === "all" ? "All topics" : escapeHtml(track)}</button>`).join("")}</div>
      <div class="search-results">${filtered.map(item => `<button class="search-result" data-lesson="${item.id}"><span class="tiny-icon">⌘</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.track)} · ${item.kind === "suggested" ? "Suggested addition" : "Supplementary notes"}</small></span><span class="muted" style="margin-left:auto">›</span></button>`).join("")}</div>`;
    $$("[data-filter]").forEach(button => button.addEventListener("click", () => { state.filter = button.dataset.filter; save(); renderSupplementary(); }));
    $$(".search-result").forEach(button => button.addEventListener("click", () => openLesson(button.dataset.lesson)));
  }
  function renderInterviews() {
    showBreadcrumb("Interview preparation");
    const examples = data.allLessons;
    $("#page-content").innerHTML = `<div class="page-heading"><div><div class="eyebrow">PRACTICE WITH EXPLANATIONS</div><h1>Interview preparation</h1>
      <p>Every course and supplementary topic includes five foundational questions, five intermediate questions, and three scenario prompts with sample reasoning. Open a topic to practice in context.</p></div></div>
      <div class="search-results">${examples.map(item => `<button class="search-result" data-lesson="${item.id}"><span class="tiny-icon">◇</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.track || "Course lesson")} · 13 question-and-answer prompts</small></span><span class="muted" style="margin-left:auto">Practice →</span></button>`).join("")}</div>
      <div class="panel" style="margin-top:14px"><div class="panel-heading"><h2>Answering scenario questions</h2></div><div class="revision-card"><p>Clarify the user goal and constraints first. Describe a baseline, data and evaluation plan, then explain trade-offs and failure handling. For high-impact or external actions, include privacy, validation, monitoring, and human oversight.</p></div></div>`;
    $$(".search-result").forEach(button => button.addEventListener("click", () => openLesson(button.dataset.lesson)));
  }
  function renderGlossary() {
    showBreadcrumb("Glossary");
    $("#page-content").innerHTML = `<div class="page-heading"><div><div class="eyebrow">QUICK DEFINITIONS</div><h1>Glossary</h1><p>A compact reference for terms used across the course topics and supplementary notes.</p></div></div>
      <div class="glossary-grid">${data.glossary.map(([term, definition]) => `<article class="glossary-item"><strong>${escapeHtml(term)}</strong><p>${escapeHtml(definition)}</p></article>`).join("")}</div>`;
  }
  function renderRevision() {
    showBreadcrumb("Quick revision");
    const list = state.saved.size ? data.allLessons.filter(item => state.saved.has(item.id)) : supplementaryLessons.slice(0, 8);
    $("#page-content").innerHTML = `<div class="page-heading"><div><div class="eyebrow">REVISIT THE ESSENTIALS</div><h1>Quick revision</h1><p>${state.saved.size ? "Your bookmarked topics, ready for a fast review." : "A starter set of supplementary concepts. Bookmark any lesson to build a personal revision list."}</p></div><div class="heading-actions"><button class="button ${state.quick ? "saved" : ""}" id="quick-toggle">${state.quick ? "Exit focus mode" : "Enable focus mode"}</button></div></div>
      <div class="${state.quick ? "quick-revision-list" : "search-results"}">${list.map(item => `<article class="revision-card"><h3>${escapeHtml(item.title)}</h3>${state.quick ? `<p><strong>Recall:</strong> What is it, and what is one limitation?</p><p><strong>Key idea:</strong> ${escapeHtml(item.summary)}</p>` : `<p>${escapeHtml(item.summary)}</p>`}<button class="text-button" style="padding:8px 0 0" data-lesson="${item.id}">Open full notes →</button></article>`).join("")}</div>`;
    $("#quick-toggle").addEventListener("click", () => {
      state.quick = !state.quick;
      document.body.classList.toggle("quick-mode", state.quick);
      save();
      renderRevision();
    });
    $$("[data-lesson]").forEach(button => button.addEventListener("click", () => openLesson(button.dataset.lesson)));
  }
  function renderSearch(query) {
    showBreadcrumb("Search");
    const q = query.trim().toLowerCase();
    const results = data.allLessons.filter(item => `${item.title} ${item.sectionTitle} ${item.summary}`.toLowerCase().includes(q)).slice(0, 50);
    $("#page-content").innerHTML = `<div class="page-heading"><div><div class="eyebrow">SEARCH YOUR LIBRARY</div><h1>Results for “${escapeHtml(query)}”</h1><p>${results.length} matching ${results.length === 1 ? "topic" : "topics"} across course lessons and supplementary notes.</p></div></div>
      <div class="search-results">${results.length ? results.map(item => `<button class="search-result" data-lesson="${item.id}"><span class="tiny-icon">${item.kind === "course" ? "▤" : "⌘"}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.sectionTitle)}${item.kind === "suggested" ? " · Suggested addition" : item.kind === "supplementary" ? " · Supplementary" : ""}</small></span><span class="muted" style="margin-left:auto">›</span></button>`).join("") : `<div class="empty-state">No matching lessons. Try a broader keyword.</div>`}</div>`;
    $$(".search-result").forEach(button => button.addEventListener("click", () => openLesson(button.dataset.lesson)));
  }
  function render() {
    renderOutline();
    if (state.search) return renderSearch(state.search);
    if (state.view === "lesson") return renderLesson(lessonById(state.current) || courseLessons[0]);
    if (state.view === "curriculum") return renderCurriculum();
    if (state.view === "supplementary") return renderSupplementary();
    if (state.view === "interviews") return renderInterviews();
    if (state.view === "glossary") return renderGlossary();
    if (state.view === "revision") return renderRevision();
    renderDashboard();
  }
  function closeSidebar() {
    $("#sidebar").classList.remove("mobile-open");
    $("#mobile-scrim").classList.remove("visible");
  }
  function toggleTheme() {
    document.body.classList.toggle("dark");
    const dark = document.body.classList.contains("dark");
    state.theme = dark ? "dark" : "light";
    save();
    ["#theme-toggle", "#theme-toggle-mobile"].forEach(selector => {
      const button = $(selector);
      button.textContent = dark ? "☀" : "☾";
      button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    });
  }
  function setup() {
    toggleThemeIcons();
    $("#auth-register-tab").addEventListener("click", () => setAuthMode("register"));
    $("#auth-login-tab").addEventListener("click", () => setAuthMode("login"));
    $("#auth-form").addEventListener("submit", handleAuthSubmit);
    $("#backup-export").addEventListener("click", downloadBackup);
    $("#backup-import").addEventListener("change", event => restoreBackup(event.target.files[0]));
    $("#logout").addEventListener("click", logout);
    window.addEventListener("online", () => {
      if (!activeAccount) return;
      const cached = readProgressCache(activeAccount.id);
      if (cached && cached.pending) queueCloudSave(cached.state, cached.updatedAt);
    });
    $("#lesson-search").addEventListener("input", event => {
      state.search = event.target.value;
      if (state.search) render(); else { state.view = "dashboard"; render(); }
      save();
    });
    $("#lesson-search").addEventListener("keydown", event => {
      if (event.key === "Escape") { event.target.value = ""; state.search = ""; state.view = "dashboard"; render(); save(); }
    });
    document.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#lesson-search").focus(); }
    });
    $("#theme-toggle").addEventListener("click", toggleTheme);
    $("#theme-toggle-mobile").addEventListener("click", toggleTheme);
    $("#open-sidebar").addEventListener("click", () => { $("#sidebar").classList.add("mobile-open"); $("#mobile-scrim").classList.add("visible"); });
    $("#close-sidebar").addEventListener("click", closeSidebar);
    $("#mobile-scrim").addEventListener("click", closeSidebar);
    $("#expand-all").addEventListener("click", () => $$(".outline-section").forEach(section => {
      section.classList.add("open"); $(".outline-head", section).setAttribute("aria-expanded", "true");
      state.expandedSections.add(section.dataset.section);
    }));
    $("#expand-all").addEventListener("click", save);
    $(".note-dismiss").addEventListener("click", () => {
      state.noteDismissed = true;
      $(".access-note").hidden = true;
      save();
    });
    document.addEventListener("click", event => {
      const viewButton = event.target.closest("[data-view]");
      if (viewButton) setView(viewButton.dataset.view);
    });
    document.addEventListener("click", async event => {
      const copy = event.target.closest(".copy-button");
      if (!copy) return;
      const code = $("code", copy.closest(".code-block")).textContent;
      try {
        await navigator.clipboard.writeText(code);
        copy.textContent = "Copied!";
        setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy code"; }, 1400);
      } catch {
        copy.textContent = "Copy unavailable";
        setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy code"; }, 1800);
      }
    });
    try {
      accounts = readAccounts();
      writeLocalAccounts();
    } catch (error) {
      renderAuth();
      setAuthMode("login");
      showAuthStatus(error.message || "Saved local profiles could not be loaded.", "error");
      return;
    }
    try {
      supabaseClient = createSupabaseClient();
      supabaseClient.auth.onAuthStateChange(event => {
        if (event === "SIGNED_OUT" && activeAccount) clearSession();
      });
      void supabaseClient.auth.getSession().then(({ data, error }) => {
        if (error) throw new Error(error.message);
        if (data.session) startSession(data.session.user);
        else {
          renderAuth();
          setAuthMode(accounts.length ? "login" : "register");
        }
      }).catch(error => {
        renderAuth();
        setAuthMode("login");
        showAuthStatus(`Could not restore your Supabase session: ${error.message}`, "error");
      });
    } catch (error) {
      renderAuth();
      setAuthMode(accounts.length ? "login" : "register");
      showAuthStatus(error.message || "Supabase could not be initialized.", "error");
    }
  }
  function toggleThemeIcons() {
    const dark = document.body.classList.contains("dark");
    ["#theme-toggle", "#theme-toggle-mobile"].forEach(selector => {
      const button = $(selector);
      button.textContent = dark ? "☀" : "☾";
      button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    });
  }
  setup();
})();
