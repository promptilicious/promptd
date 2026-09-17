const view = document.getElementById('view');
const connEl = document.getElementById('conn');
const toastsEl = document.getElementById('toasts');
const updateBadgeEl = document.getElementById('update-badge');
const usageEl = document.getElementById('usage');
const systemEl = document.getElementById('system');

let logStream = null; // EventSource tailing one log file
let modelPollTimer = null; // set while model discovery is still running
let reloadTimer = null; // counting down to a reload after an update was started
let updateWatchTimer = null; // polling while an update waits for runs to finish
// The commit the server reported when this page loaded. If it ever differs, the
// server has been updated underneath us and this page is running old code.
let loadedCommit = null;
let staleBuild = false;

// ---- helpers ----------------------------------------------------------

async function api(url, options) {
  const res = await fetch(url, {
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || `request failed (${res.status})`);
  return body;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function fmtDateTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtRelative(iso) {
  if (!iso) return '';
  const deltaMs = new Date(iso).getTime() - Date.now();
  const past = deltaMs < 0;
  let seconds = Math.round(Math.abs(deltaMs) / 1000);
  const units = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  const parts = [];
  for (const [label, size] of units) {
    if (seconds >= size && parts.length < 2) {
      parts.push(`${Math.floor(seconds / size)}${label}`);
      seconds %= size;
    }
  }
  const text = parts.join(' ') || '0s';
  return past ? `${text} ago` : `in ${text}`;
}

/**
 * A run length, always down to the second so a live clock ticks visibly.
 * Minutes and hours are zero-padded so the digits do not jump around.
 */
function fmtDuration(ms) {
  let seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  seconds %= 60;
  const pad = (value) => String(value).padStart(2, '0');
  if (hours) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/** How long a run that started at `iso` has been going. */
function fmtElapsed(iso) {
  return fmtDuration(Date.now() - new Date(iso).getTime());
}

/**
 * One interval drives every live clock on the page. An element opts in by
 * carrying data-runtime-start (the run's ISO start time); each tick rewrites
 * its text. Nothing to update is a single empty query, so this stays cheap.
 */
function tickRuntimes() {
  for (const node of document.querySelectorAll('[data-runtime-start]')) {
    node.textContent = fmtElapsed(node.dataset.runtimeStart);
  }
}

/**
 * Money, at the precision the number deserves: a run costs cents and needs four
 * decimals to say so, a lifetime total of hundreds does not.
 */
function fmtCost(usd) {
  if (!Number.isFinite(usd)) return '—';
  return usd >= 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Toasts stack, so several changes landing at once stay readable.
 *
 * A `key` makes one replace itself instead. That is what keeps a cron on a
 * 30-second schedule from stacking hundreds of identical drop notices through a
 * six hour pause: the same cron reuses its toast and updates the count.
 */
function toast(message, bad = false, key = null) {
  if (key) toastsEl.querySelector(`[data-toast-key="${CSS.escape(key)}"]`)?.remove();
  const node = el('div', { class: bad ? 'toast bad' : 'toast', text: message });
  if (key) node.dataset.toastKey = key;
  toastsEl.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  }, bad ? 6000 : 3500);
  // Never let a burst pile up past a screenful.
  while (toastsEl.children.length > 5) toastsEl.firstElementChild.remove();
}

/**
 * Which API a job lives behind. Crons and one-time executions answer the same
 * run, stop and log routes under different prefixes, so every shared control
 * asks this rather than hard-coding one of them.
 */
function apiBase(job) {
  return job?.kind === 'execution' ? 'executions' : 'crons';
}

/** Where the page keeps a job: the crons tab and its pages, or the one-time ones. */
function hashBase(job) {
  return job?.kind === 'execution' ? '#/one-time' : '#';
}

/**
 * A live run keeps its running badge through a pause and picks up the paused
 * badge when it finishes. A deactivated cron stays deactivated: a pause does
 * not change it, and lifting the pause will not arm it.
 */
function statusPill(cron, pause) {
  if (cron.isRunning) return el('span', { class: 'pill running' }, [el('span', { class: 'led' }), 'running']);
  if (cron.isDelayed) {
    return el('span', { class: 'pill delayed', title: delayTitle(cron.delayed) }, [el('span', { class: 'led' }), 'delayed']);
  }
  if (!cron.isActive) return el('span', { class: 'pill paused' }, [el('span', { class: 'led' }), 'deactivated']);
  if (pause?.paused) {
    return el(
      'span',
      { class: 'pill held', title: pauseTitle(pause) },
      [el('span', { class: 'led' }), pause.badge],
    );
  }
  return el('span', { class: 'pill active' }, [el('span', { class: 'led' }), 'armed']);
}

/**
 * What a one-time execution is doing, which is a life rather than a schedule:
 * it is waiting for its date, running, or finished with whatever it finished as.
 *
 * `overdue` is the gap between a trigger being missed and the catch-up starting
 * the run — after a restart, or while a pause is holding it.
 */
function executionPill(execution, pause) {
  if (execution.isRunning) return el('span', { class: 'pill running' }, [el('span', { class: 'led' }), 'running']);
  if (execution.isDelayed) {
    return el('span', { class: 'pill delayed', title: delayTitle(execution.delayed) }, [el('span', { class: 'led' }), 'delayed']);
  }
  if (!execution.isActive) return el('span', { class: 'pill paused' }, [el('span', { class: 'led' }), 'deactivated']);
  if (execution.status === 'cancelled') {
    return el('span', { class: 'pill warn', title: `Dropped by ${execution.stoppedBy ?? 'the user'} before it ran.` }, [
      el('span', { class: 'led' }),
      'cancelled',
    ]);
  }
  // Neutral on purpose: how the run ended is the Outcome column's job, and a
  // row saying "succeeded" twice tells you nothing the second time.
  if (execution.status === 'done') {
    return el('span', { class: 'pill', title: `Ran ${fmtRelative(execution.lastRunAt)}.` }, [
      el('span', { class: 'led' }),
      'done',
    ]);
  }
  if (execution.isOverdue) {
    return el(
      'span',
      {
        class: 'pill delayed',
        title: pause?.paused
          ? 'Its time has passed while everything is paused. It runs when the pause lifts.'
          : 'Its time has passed and the run is being started now.',
      },
      [el('span', { class: 'led' }), pause?.paused ? 'held' : 'starting'],
    );
  }
  if (pause?.paused) {
    return el('span', { class: 'pill held', title: pauseTitle(pause) }, [el('span', { class: 'led' }), pause.badge]);
  }
  return el('span', { class: 'pill active' }, [el('span', { class: 'led' }), 'scheduled']);
}

/** The limits a held trigger is waiting on, e.g. "Session, Weekly". */
function delayNames(delayed) {
  return (delayed?.reasons ?? []).map((reason) => reason.label).join(', ');
}

/**
 * Hover text for a delayed badge: which limits are holding the trigger, what
 * each is at, and the earliest the run can start.
 */
function delayTitle(delayed) {
  if (!delayed) return '';
  const lines = ['Waiting on a spent usage limit.'];
  for (const reason of delayed.reasons ?? []) {
    const resets = reason.resetsAt
      ? `resets ${fmtRelative(reason.resetsAt)} (${fmtDateTime(reason.resetsAt)})`
      : 'no reset time reported';
    lines.push(`${reason.label}: ${Math.round(reason.usedPercent)}% used, ${resets}`);
  }
  // Usage is only read every five minutes, and a waiting run adds no lookups of
  // its own, so the start can trail the reset by that much.
  lines.push(
    delayed.resumeAt
      ? `Starts ${fmtRelative(delayed.resumeAt)} (${fmtDateTime(delayed.resumeAt)}), give or take the 5 minute usage check.`
      : 'Starts when the next usage check shows it clear. Usage is checked every 5 minutes.',
  );
  lines.push(`Waiting since ${fmtDateTime(delayed.delayedAt)}. Stop drops it.`);
  return lines.join('\n');
}

/** Hover text for a paused badge: when it lifts, or why it cannot be lifted. */
function pauseTitle(pause) {
  if (pause.mode === 'update') return 'An update is waiting for runs to finish, then the server restarts.';
  if (pause.until) return `Schedules resume ${fmtRelative(pause.until)}, at ${fmtDateTime(pause.until)}.`;
  return 'Schedules resume when the pause is cancelled or the server restarts.';
}

/**
 * Pause for… while running normally, Cancel pause while the user paused, and
 * neither during an update — that pause is not the user's to lift.
 */
function pauseControl(pause, options, onChanged) {
  if (pause.paused && pause.mode === 'update') return null;

  if (pause.paused) {
    return el('button', {
      class: 'btn',
      text: 'Cancel pause',
      onclick: async (event) => {
        event.target.disabled = true;
        try {
          await api('/api/pause', { method: 'DELETE' });
          toast('Schedules resumed');
          onChanged?.();
        } catch (err) {
          toast(err.message, true);
          event.target.disabled = false;
        }
      },
    });
  }

  const select = el('select', { class: 'select pause-select', 'aria-label': 'Pause all crons' }, [
    el('option', { value: '', selected: 'selected' }, 'Pause for…'),
    ...options.map((option) => el('option', { value: option.id }, option.label)),
  ]);
  select.addEventListener('change', async () => {
    const option = select.value;
    if (!option) return;
    select.disabled = true;
    try {
      const state = await api('/api/pause', { method: 'POST', body: JSON.stringify({ option }) });
      toast(`Paused ${state.label}`);
      onChanged?.();
    } catch (err) {
      toast(err.message, true);
      select.value = '';
      select.disabled = false;
    }
  });
  return select;
}

/**
 * Amber badge standing in for the outcome while a run is in flight: there is no
 * outcome yet, so the cell carries how long this run has been going instead.
 */
function runtimePill(startedAt) {
  if (!startedAt) return el('span', { class: 'pill running' }, [el('span', { class: 'led' }), 'running']);
  return el('span', { class: 'pill runtime', title: `Running since ${fmtDateTime(startedAt)}` }, [
    el('span', { class: 'led' }),
    el('span', { 'data-runtime-start': startedAt, text: fmtElapsed(startedAt) }),
  ]);
}

function outcomePill(status) {
  if (!status) return el('span', { class: 'muted' }, '—');
  const cls = status === 'succeeded' ? 'pill active' : status === 'stopped' ? 'pill warn' : 'pill failed';
  return el('span', { class: cls }, [el('span', { class: 'led' }), status]);
}

/**
 * One button that swaps role: Run now while idle, Stop while a run is in flight.
 * Stopping kills the child process; the schedule is untouched, so an armed cron
 * still fires at its next trigger. Run now is disabled while paused — a pause
 * means nothing new starts — but Stop never is, so a live run can always be
 * ended.
 */
function runControl(cron, { small = false, onStarted, pause } = {}) {
  const size = small ? 'btn small' : 'btn';

  if (cron.isRunning) {
    const stopping = Boolean(cron.currentRun?.stopping);
    return el('button', {
      class: `${size} danger`,
      text: stopping ? 'Stopping…' : 'Stop',
      disabled: stopping,
      onclick: async (event) => {
        event.target.disabled = true;
        try {
          await api(`/api/${apiBase(cron)}/${cron.id}/stop`, { method: 'POST' });
          toast(`Stopping "${cron.name}"`);
        } catch (err) {
          toast(err.message, true);
          event.target.disabled = false;
        }
      },
    });
  }

  // A held trigger is a pending execution, so the button that would start one
  // becomes the button that drops it. Never disabled by a pause, for the same
  // reason Stop is not: you can always take back something that is queued.
  if (cron.isDelayed) {
    return el('button', {
      class: `${size} danger`,
      text: 'Stop',
      title: delayTitle(cron.delayed),
      onclick: async (event) => {
        event.target.disabled = true;
        try {
          await api(`/api/${apiBase(cron)}/${cron.id}/stop`, { method: 'POST' });
          toast(`"${cron.name}" is no longer waiting`);
        } catch (err) {
          toast(err.message, true);
          event.target.disabled = false;
        }
      },
    });
  }

  if (pause?.paused) {
    // The title sits on a wrapper, not the button: a disabled control does not
    // reliably receive hover, so the tooltip would never appear on some browsers.
    return el(
      'span',
      {
        class: 'btn-hold',
        title:
          pause.mode === 'update'
            ? 'Paused for update — an update is waiting for runs to finish, so nothing new can start.'
            : `Everything is paused ${pause.label}. Cancel the pause to run one.`,
      },
      [
        el('button', {
          class: small ? 'btn small' : 'btn primary',
          text: 'Run now',
          disabled: 'disabled',
        }),
      ],
    );
  }

  return el('button', {
    class: small ? 'btn small' : 'btn primary',
    text: 'Run now',
    onclick: async (event) => {
      event.target.disabled = true;
      try {
        const result = await api(`/api/${apiBase(cron)}/${cron.id}/run`, { method: 'POST' });
        onStarted?.();
        // Run now does not override the usage delay setting; a blocked press
        // becomes the waiting trigger instead of starting claude anyway.
        if (result?.delayed) toast(`"${cron.name}" is waiting on ${delayNames(result.delayed)}.`, true);
        else toast(`Started "${cron.name}"`);
      } catch (err) {
        toast(err.message, true);
        event.target.disabled = false;
      }
    },
  });
}

// ---- home -------------------------------------------------------------

/**
 * How much of the one-time list is on screen.
 *
 * Kept outside the render so that a run event redrawing the page does not throw
 * away the older pages the user has loaded: the redraw asks for the same number
 * of rows again rather than starting back at ten.
 */
const executionsState = { limit: 10, pageSize: 10 };

/** The two tabs, and which one the hash is asking for. */
const TABS = [
  { id: 'crons', label: 'Crons', hash: '#/' },
  { id: 'executions', label: 'One-time Execution', hash: '#/one-time' },
];

function tabBar(current) {
  return el(
    'nav',
    { class: 'tabs', role: 'tablist' },
    TABS.map((tab) =>
      el('a', {
        class: `tab${tab.id === current ? ' selected' : ''}`,
        href: tab.hash,
        role: 'tab',
        'aria-selected': tab.id === current ? 'true' : 'false',
        text: tab.label,
      }),
    ),
  );
}

/**
 * The pause sentence both tabs share, since one pause holds both: crons stop
 * firing and one-time executions stop starting.
 */
function pauseSummary(pause) {
  if (!pause.paused) return null;
  if (pause.mode === 'update') {
    return pause.runningCount
      ? `Paused for update — waiting for ${pause.runningCount} run${pause.runningCount === 1 ? '' : 's'} to finish`
      : 'Paused for update — restarting';
  }
  return pause.until ? `paused ${pause.label}, resumes ${fmtRelative(pause.until)}` : `paused ${pause.label}`;
}

/**
 * The home page: one header, one pause control, and two tabs under it.
 *
 * The pause sits outside the tabs on purpose. It is not a property of either
 * list — it holds every cron and every one-time execution at once — so putting
 * a copy inside each tab would have suggested there were two of them.
 */
async function renderHome(tab = 'crons') {
  const pause = await api('/api/pause');

  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [el('h1', { text: 'Claude Conductor' }), el('p', { class: 'sub', id: 'home-sub', text: '' })]),
    el('div', { class: 'head-actions' }, [
      pauseControl(pause, pause.options ?? [], () => renderHome(tab).catch(() => {})),
      tab === 'executions'
        ? el('a', { class: 'btn primary', href: '#/one-time/new', text: '+ New one-time execution' })
        : el('a', { class: 'btn primary', href: '#/new', text: '+ New cron' }),
    ]),
  ]);

  const panel = el('div', { class: 'tab-panel', role: 'tabpanel' });
  view.replaceChildren(head, tabBar(tab), panel);

  const sub = (text) => {
    const node = document.getElementById('home-sub');
    if (node) node.textContent = text;
  };

  if (tab === 'executions') await paintExecutions(panel, pause, sub);
  else await paintCrons(panel, pause, sub);
}

/** The Crons tab: everything the home page showed before the tabs existed. */
async function paintCrons(panel, pause, sub) {
  const crons = await api('/api/crons');
  const armed = crons.filter((c) => c.isActive).length;

  let line;
  if (!crons.length) line = 'Nothing scheduled yet';
  else if (pause.paused && pause.mode === 'update') line = pauseSummary(pause);
  else if (pause.paused) line = `${armed} armed of ${crons.length} — ${pauseSummary(pause)}`;
  else line = `${armed} armed of ${crons.length}`;

  const held = crons.filter((c) => c.isDelayed).length;
  if (held) line += ` · ${held} waiting on usage`;
  if (pause.paused && pause.droppedCount) {
    line += ` · ${pause.droppedCount} trigger${pause.droppedCount === 1 ? '' : 's'} dropped`;
  }
  sub(line);

  if (!crons.length) {
    panel.replaceChildren(
      el('div', { class: 'panel' }, [
        el('div', { class: 'empty' }, [
          el('p', { text: 'No crons yet.' }),
          el('a', { class: 'btn primary', href: '#/new', text: 'Create your first cron' }),
        ]),
      ]),
    );
    return;
  }

  const rows = crons.map((cron) =>
    el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'cron-name', text: cron.name }),
        cron.description ? el('div', { class: 'cron-desc', text: cron.description }) : null,
        el('div', { class: 'cron-desc mono', text: cron.cron }),
      ]),
      el('td', {}, [statusPill(cron, pause)]),
      el('td', { class: 'hide-sm' }, [
        cron.lastRunAt
          ? el('div', {}, [
              el('div', { text: fmtRelative(cron.lastRunAt) }),
              el('div', { class: 'cron-desc', text: fmtDateTime(cron.lastRunAt) }),
            ])
          : el('span', { class: 'muted', text: 'never' }),
      ]),
      el('td', { class: 'hide-sm' }, [
        cron.isRunning ? runtimePill(cron.currentRun?.startedAt) : outcomePill(cron.lastRunStatus),
      ]),
      el('td', { class: 'hide-sm' }, [nextRunCell(cron, pause)]),
      el('td', {}, [
        el('div', { class: 'row-actions' }, [
          runControl(cron, { small: true, pause }),
          el('a', { class: 'btn small', href: `#/edit/${cron.id}`, text: 'Edit' }),
          el('a', { class: 'btn small', href: `#/logs/${cron.id}`, text: 'View logs' }),
        ]),
      ]),
    ]),
  );

  panel.replaceChildren(
    el('div', { class: 'panel' }, [
      el('table', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Name' }),
            el('th', { text: 'Status' }),
            el('th', { class: 'hide-sm', text: 'Last ran' }),
            el('th', { class: 'hide-sm', text: 'Outcome' }),
            el('th', { class: 'hide-sm', text: 'Next run' }),
            el('th', {}, ''),
          ]),
        ]),
        el('tbody', {}, rows),
      ]),
    ]),
  );
}

/** The Next run cell: a held trigger, a real schedule, or nothing to say. */
function nextRunCell(cron, pause) {
  if (cron.isDelayed) {
    return el('div', { title: delayTitle(cron.delayed) }, [
      el('div', { text: cron.delayed.resumeAt ? fmtRelative(cron.delayed.resumeAt) : 'when usage clears' }),
      el('div', {
        class: 'cron-desc',
        text: cron.delayed.resumeAt ? fmtDateTime(cron.delayed.resumeAt) : `held for ${delayNames(cron.delayed)}`,
      }),
    ]);
  }
  if (!cron.nextRunAt) return el('span', { class: 'muted', text: cron.isActive ? 'not scheduled' : 'deactivated' });
  // A pause leaves the schedule registered, so this time is real — it is when
  // the trigger arrives and is thrown away, not when it runs.
  return el(
    'div',
    {
      title: pause.paused
        ? 'Every schedule is paused, so this trigger is dropped when it arrives. A pause misses runs, it does not queue them.'
        : null,
    },
    [
      el('div', { text: fmtRelative(cron.nextRunAt) }),
      el('div', {
        class: 'cron-desc',
        text: pause.paused ? `${fmtDateTime(cron.nextRunAt)} · dropped` : fmtDateTime(cron.nextRunAt),
      }),
    ],
  );
}

/**
 * The One-time Execution tab: the ten most recent, newest first, and a button
 * that loads ten more.
 *
 * A one-time execution that has run stays here as history. It can be run again
 * by hand, and a save that moves its date arms it afresh; nothing re-fires it
 * on its own.
 */
async function paintExecutions(panel, pause, sub) {
  const page = await api(`/api/executions?limit=${executionsState.limit}`);
  const executions = page.items;

  let line;
  if (!page.total) line = 'Nothing scheduled yet';
  else if (pause.paused && pause.mode === 'update') line = pauseSummary(pause);
  else if (pause.paused) line = `${page.scheduled} scheduled of ${page.total} — ${pauseSummary(pause)}`;
  else line = `${page.scheduled} scheduled of ${page.total}`;

  const held = executions.filter((execution) => execution.isDelayed).length;
  if (held) line += ` · ${held} waiting on usage`;
  sub(line);

  if (!page.total) {
    panel.replaceChildren(
      el('div', { class: 'panel' }, [
        el('div', { class: 'empty' }, [
          el('p', { text: 'No one-time executions yet.' }),
          el('p', {
            class: 'cron-desc',
            text: 'A one-time execution is a prompt with a date instead of a schedule. It runs once, then stays here as history.',
          }),
          el('a', { class: 'btn primary', href: '#/one-time/new', text: 'Schedule your first one' }),
        ]),
      ]),
    );
    return;
  }

  const rows = executions.map((execution) =>
    el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'cron-name', text: execution.name }),
        execution.description ? el('div', { class: 'cron-desc', text: execution.description }) : null,
        el('div', { class: 'cron-desc mono', text: 'one-time' }),
      ]),
      el('td', {}, [executionPill(execution, pause)]),
      el('td', { class: 'hide-sm' }, [
        execution.lastRunAt
          ? el('div', {}, [
              el('div', { text: fmtRelative(execution.lastRunAt) }),
              el('div', { class: 'cron-desc', text: fmtDateTime(execution.lastRunAt) }),
            ])
          : el('span', { class: 'muted', text: 'never' }),
      ]),
      el('td', { class: 'hide-sm' }, [
        execution.isRunning ? runtimePill(execution.currentRun?.startedAt) : outcomePill(execution.lastRunStatus),
      ]),
      el('td', { class: 'hide-sm' }, [scheduledCell(execution, pause)]),
      el('td', {}, [
        el('div', { class: 'row-actions' }, [
          runControl(execution, { small: true, pause }),
          rearmControl(execution),
          el('a', { class: 'btn small', href: `#/one-time/edit/${execution.id}`, text: 'Edit' }),
          el('a', { class: 'btn small', href: `#/one-time/logs/${execution.id}`, text: 'View logs' }),
        ]),
      ]),
    ]),
  );

  const more = page.nextBefore
    ? el('div', { class: 'load-more' }, [
        el('button', {
          class: 'btn',
          text: `Load ${executionsState.pageSize} older`,
          onclick: (event) => {
            event.target.disabled = true;
            event.target.textContent = 'Loading…';
            executionsState.limit += executionsState.pageSize;
            renderHome('executions').catch(() => {});
          },
        }),
        el('span', { class: 'cron-desc', text: `Showing ${executions.length} of ${page.total}` }),
      ])
    : executions.length > executionsState.pageSize
      ? el('div', { class: 'load-more' }, [el('span', { class: 'cron-desc', text: `All ${page.total} shown` })])
      : null;

  panel.replaceChildren(
    el('div', { class: 'panel' }, [
      el('table', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Name' }),
            el('th', { text: 'Status' }),
            el('th', { class: 'hide-sm', text: 'Last ran' }),
            el('th', { class: 'hide-sm', text: 'Outcome' }),
            el('th', { class: 'hide-sm', text: 'Scheduled for' }),
            el('th', {}, ''),
          ]),
        ]),
        el('tbody', {}, rows),
      ]),
      more,
    ]),
  );
}

/** When a one-time execution goes, or when it went and what became of it. */
function scheduledCell(execution, pause) {
  if (execution.isDelayed) {
    return el('div', { title: delayTitle(execution.delayed) }, [
      el('div', { text: execution.delayed.resumeAt ? fmtRelative(execution.delayed.resumeAt) : 'when usage clears' }),
      el('div', {
        class: 'cron-desc',
        text: execution.delayed.resumeAt ? fmtDateTime(execution.delayed.resumeAt) : `held for ${delayNames(execution.delayed)}`,
      }),
    ]);
  }
  const when = el('div', { text: fmtDateTime(execution.scheduledAt) ?? '—' });
  if (execution.status !== 'scheduled' || !execution.isActive) {
    const note =
      !execution.isActive
        ? 'deactivated'
        : execution.status === 'cancelled'
          ? `dropped by ${execution.stoppedBy ?? 'the user'}`
          : execution.status === 'running'
            ? 'running now'
            : 'already run';
    return el('div', {}, [when, el('div', { class: 'cron-desc', text: note })]);
  }
  return el(
    'div',
    {
      title: pause.paused
        ? 'Everything is paused. This one waits, and runs when the pause lifts.'
        : null,
    },
    [
      el('div', { text: execution.isOverdue ? 'overdue' : fmtRelative(execution.scheduledAt) }),
      el('div', { class: 'cron-desc', text: fmtDateTime(execution.scheduledAt) }),
    ],
  );
}

/**
 * Puts a finished or cancelled execution back on its own date, when that date
 * has not passed yet. Anything else is an edit, which the form already does.
 */
function rearmControl(execution) {
  if (execution.isRunning || execution.isDelayed) return null;
  if (execution.status === 'scheduled') return null;
  if (Date.parse(execution.scheduledAt ?? '') <= Date.now()) return null;
  return el('button', {
    class: 'btn small',
    text: 'Reschedule',
    title: `Arm it again for ${fmtDateTime(execution.scheduledAt)}.`,
    onclick: async (event) => {
      event.target.disabled = true;
      try {
        await api(`/api/executions/${execution.id}/rearm`, { method: 'POST' });
        toast(`"${execution.name}" is scheduled again`);
      } catch (err) {
        toast(err.message, true);
        event.target.disabled = false;
      }
    },
  });
}

// ---- edit / create ---------------------------------------------------

const DIR_HINT = 'Where claude runs. Type to search, ↑↓ to pick, Enter to accept.';

const CRON_FIELD_HELP = {
  s: 'Seconds — 0 to 59',
  m: 'Minutes — 0 to 59',
  h: 'Hours — 0 to 23',
  dom: 'Day of month — 1 to 31',
  mon: 'Month — 1 to 12, or JAN to DEC',
  dow: 'Day of week — 0 to 7, or SUN to SAT. 0 and 7 are both Sunday.',
};

/** Renders "(m h dom mon dow)" with each field name explaining itself on hover. */
function cronFieldLegend(fields) {
  const parts = [];
  fields.forEach((field, index) => {
    if (index) parts.push(' ');
    parts.push(el('abbr', { class: 'cron-field', 'data-tip': CRON_FIELD_HELP[field], text: field }));
  });
  return el('span', { class: 'legend' }, ['(', ...parts, ')']);
}

/**
 * Wraps the Cron input in shortcuts and live feedback: preset buttons, a
 * time-of-day entry, and the next fire time recomputed as the field changes.
 */
function cronPicker(input) {
  const preview = el('div', { class: 'hint' });
  let debounce = null;
  let seq = 0;

  const update = () => {
    const mine = ++seq;
    const expression = input.value.trim();
    if (!expression) {
      preview.textContent = '';
      preview.className = 'hint';
      return;
    }
    api(`/api/next-run?cron=${encodeURIComponent(expression)}`)
      .then((result) => {
        if (mine !== seq) return; // a later keystroke already won
        if (!result.valid) {
          preview.textContent = result.error;
          preview.className = 'hint warn';
          return;
        }
        preview.textContent = `Next run: ${fmtRelative(result.nextRunAt)} · ${fmtDateTime(result.nextRunAt)}`;
        preview.className = 'hint ok';
      })
      .catch(() => {});
  };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(update, 200);
  });

  const apply = (expression) => {
    input.value = expression;
    update();
  };

  const preset = (label, expression, title) =>
    el('button', {
      type: 'button',
      class: 'btn small',
      text: label,
      title,
      onclick: () => apply(expression),
    });

  const timeEntry = el('input', { type: 'time', class: 'time-entry', value: '09:00' });
  const applyTime = () => {
    const [hours, minutes] = timeEntry.value.split(':');
    if (hours === undefined || minutes === undefined) return;
    apply(`${Number(minutes)} ${Number(hours)} * * *`);
  };
  timeEntry.addEventListener('change', applyTime);

  update();

  return el('div', { class: 'field' }, [
    el('label', { text: 'Cron' }),
    input,
    el('div', { class: 'preset-row' }, [
      preset('30s', '*/30 * * * * *', 'Every 30 seconds'),
      preset('15m', '*/15 * * * *', 'Every 15 minutes'),
      preset('1hr', '0 * * * *', 'Every hour, on the hour'),
      el('span', { class: 'preset-sep' }),
      el('span', { class: 'preset-label', text: 'Daily at' }),
      timeEntry,
      el('button', { type: 'button', class: 'btn small', text: 'Set', onclick: applyTime }),
    ]),
    el('div', { class: 'hint' }, [
      'Five fields ',
      cronFieldLegend(['m', 'h', 'dom', 'mon', 'dow']),
      '. For seconds, add a sixth field at the front ',
      cronFieldLegend(['s', 'm', 'h', 'dom', 'mon', 'dow']),
      '. Server local time.',
    ]),
    preview,
  ]);
}

/**
 * Wraps the Working Directory input in a directory picker: suggestions from the
 * server as you type, keyboard selection, and a live note of where the path lands.
 */
function directoryPicker(input) {
  const menu = el('div', { class: 'combo-menu', hidden: 'hidden' });
  const hint = el('div', { class: 'hint', text: DIR_HINT });
  let items = [];
  let active = -1;
  let debounce = null;
  let seq = 0;

  const close = () => {
    menu.hidden = true;
    active = -1;
  };

  const paint = () => {
    menu.replaceChildren(
      ...items.map((suggestion, index) =>
        el(
          'button',
          {
            type: 'button',
            class: `combo-item mono${index === active ? ' active' : ''}`,
            // mousedown, not click: it fires before blur, so the menu is still open.
            onmousedown: (event) => {
              event.preventDefault();
              accept(index);
            },
          },
          suggestion,
        ),
      ),
    );
    menu.hidden = items.length === 0;
    if (active >= 0) menu.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  const accept = (index) => {
    if (!items[index]) return;
    input.value = items[index];
    input.focus();
    // Accepting ends in a slash, so re-querying lists what is inside it.
    lookup();
  };

  const lookup = () => {
    const mine = ++seq;
    api(`/api/browse?path=${encodeURIComponent(input.value)}`)
      .then((result) => {
        if (mine !== seq) return; // a later keystroke already won
        items = result.suggestions;
        active = -1;
        paint();
        if (!input.value.trim()) {
          hint.textContent = DIR_HINT;
          hint.className = 'hint';
        } else {
          hint.textContent = result.exists ? `→ ${result.resolved}` : `${result.resolved} does not exist`;
          hint.className = result.exists ? 'hint ok' : 'hint warn';
        }
      })
      .catch(() => {});
  };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(lookup, 120);
  });
  input.addEventListener('focus', lookup);
  input.addEventListener('blur', () => setTimeout(close, 120));

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.stopPropagation();
      close();
      return;
    }
    if (menu.hidden || !items.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + items.length) % items.length;
      paint();
    } else if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0) {
      // Without this, Enter would submit the form instead of taking the suggestion.
      event.preventDefault();
      accept(active);
    }
  });

  return el('div', { class: 'field' }, [
    el('label', { text: 'Working Directory' }),
    el('div', { class: 'combo' }, [input, menu]),
    hint,
  ]);
}

/**
 * Model dropdown, filled from whatever the installed CLI recognises. Both the
 * select and the Refresh button are disabled while discovery is running, since
 * it spawns a probe per candidate and takes a few seconds.
 */
function modelPicker(selected) {
  const select = el('select', { class: 'select mono' });
  const refresh = el('button', { type: 'button', class: 'btn small', text: 'Refresh' });
  const note = el('div', { class: 'hint' });
  let current = selected ?? '';

  const paint = (state) => {
    current = select.value || current;
    const options = [{ value: '', label: 'Default (whatever the CLI is set to)' }, ...state.models];
    // A model saved earlier that this CLI no longer lists must not be silently dropped.
    if (current && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: `${current} (not in this CLI's catalog)` });
    }
    select.replaceChildren(
      ...options.map((option) => el('option', { value: option.value, selected: option.value === current }, option.label)),
    );
    select.value = current;

    select.disabled = state.loading;
    refresh.disabled = state.loading;
    refresh.textContent = state.loading ? 'Looking up…' : 'Refresh';

    if (state.loading) {
      note.textContent = 'Asking claude which models it recognises…';
      note.className = 'hint';
    } else if (state.error) {
      note.textContent = `Could not list models: ${state.error}`;
      note.className = 'hint warn';
    } else {
      note.textContent = `${state.models.length} models, checked ${fmtRelative(state.discoveredAt)}. Passed to claude as --model.`;
      note.className = 'hint';
    }
  };

  const load = () =>
    api('/api/models')
      .then((state) => {
        paint(state);
        // Discovery started at boot may still be running; check back until it lands.
        if (state.loading) {
          clearTimeout(modelPollTimer);
          modelPollTimer = setTimeout(load, 1000);
        }
      })
      .catch((err) => {
        note.textContent = err.message;
        note.className = 'hint warn';
      });

  refresh.addEventListener('click', async () => {
    paint({ models: [], loading: true, error: null, discoveredAt: null });
    try {
      paint(await api('/api/models/refresh', { method: 'POST' }));
      toast('Model list refreshed');
    } catch (err) {
      paint({ models: [], loading: false, error: err.message, discoveredAt: null });
    }
  });

  paint({ models: [], loading: true, error: null, discoveredAt: null });
  load();

  return {
    read: () => select.value,
    field: el('div', { class: 'field' }, [
      el('label', { text: 'Model' }),
      el('div', { class: 'select-row' }, [select, refresh]),
      note,
    ]),
  };
}

/**
 * Effort dropdown. The levels come from the server, so the list here and the
 * value the run is allowed to pass stay one list. Empty leaves --effort off.
 */
function effortPicker(selected) {
  const select = el('select', { class: 'select mono' });
  const note = el('div', {
    class: 'hint',
    text: 'Passed to claude as --effort. Higher levels think longer, so runs cost more and take longer.',
  });
  const current = selected ?? '';

  const paint = (levels) => {
    const options = [
      { value: '', label: 'Default (whatever the CLI is set to)' },
      ...levels.map((level) => ({ value: level.id, label: level.label })),
    ];
    // An effort saved earlier that this server no longer offers must not be silently dropped.
    if (current && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: `${current} (no longer offered)` });
    }
    select.replaceChildren(
      ...options.map((option) => el('option', { value: option.value, selected: option.value === current }, option.label)),
    );
    select.value = current;
  };

  paint([]);
  api('/api/config')
    .then((config) => paint(config.effortLevels ?? []))
    .catch((err) => {
      note.textContent = `Could not load the effort levels: ${err.message}`;
      note.className = 'hint warn';
    });

  return {
    read: () => select.value,
    field: el('div', { class: 'field' }, [el('label', { text: 'Effort' }), select, note]),
  };
}

/**
 * Delay for usage: the limits a trigger should wait out rather than run through.
 * The categories come from the server, so the checkboxes here and the limits a
 * held trigger is actually checked against stay one list.
 */
function usageDelayPicker(selected) {
  const boxes = new Map();
  const grid = el('div', { class: 'delay-grid' });
  const note = el('div', {
    class: 'hint',
    text:
      'A ticked limit that is spent makes the run wait instead of starting, Run now included. ' +
      'It starts when usage clears, within about 5 minutes. Only one run waits at a time; any ' +
      'trigger that arrives while it waits is dropped.',
  });

  const paint = (categories) => {
    boxes.clear();
    grid.replaceChildren(
      ...categories.map((category) => {
        const box = el('input', { type: 'checkbox' });
        box.checked = Boolean(selected?.[category.id]);
        boxes.set(category.id, box);
        return el('label', { class: 'check', title: category.hint }, [box, category.label]);
      }),
    );
  };

  paint([]);
  api('/api/config')
    .then((config) => paint(config.usageDelayCategories ?? []))
    .catch((err) => {
      note.textContent = `Could not load the usage categories: ${err.message}`;
      note.className = 'hint warn';
    });

  return {
    read: () => Object.fromEntries([...boxes].map(([id, box]) => [id, box.checked])),
    field: el('div', { class: 'field' }, [el('label', { text: 'Delay for usage' }), grid, note]),
  };
}

/**
 * Wraps the date field in the same live feedback the Cron field gets: presets
 * for the times you actually pick, and a line saying how far off it is.
 *
 * The field is a plain datetime-local, so what you type is your own clock. The
 * server stores it as UTC, which is why the note under it reads the time back.
 */
function scheduledAtPicker(input) {
  const preview = el('div', { class: 'hint' });

  const update = () => {
    const raw = input.value.trim();
    if (!raw) {
      preview.textContent = '';
      preview.className = 'hint';
      return;
    }
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) {
      preview.textContent = 'That is not a date this browser understands.';
      preview.className = 'hint warn';
      return;
    }
    if (at.getTime() <= Date.now()) {
      // Allowed on purpose: the same rule that runs a trigger missed over a
      // restart runs this one the moment it is saved.
      preview.textContent = `That time has passed — saving this runs it now (${fmtDateTime(at.toISOString())}).`;
      preview.className = 'hint warn';
      return;
    }
    preview.textContent = `Runs ${fmtRelative(at.toISOString())} · ${fmtDateTime(at.toISOString())}`;
    preview.className = 'hint ok';
  };

  input.addEventListener('input', update);
  input.addEventListener('change', update);

  /** Local time in the shape datetime-local wants, which is not toISOString. */
  const asFieldValue = (date) => {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const inMinutes = (label, minutes, title) =>
    el('button', {
      type: 'button',
      class: 'btn small',
      text: label,
      title,
      onclick: () => {
        input.value = asFieldValue(new Date(Date.now() + minutes * 60000));
        update();
      },
    });

  const tomorrowAt = el('input', { type: 'time', class: 'time-entry', value: '09:00' });
  const applyTomorrow = () => {
    const [hours, minutes] = tomorrowAt.value.split(':');
    if (hours === undefined || minutes === undefined) return;
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(Number(hours), Number(minutes), 0, 0);
    input.value = asFieldValue(date);
    update();
  };
  tomorrowAt.addEventListener('change', applyTomorrow);

  update();

  return el('div', { class: 'field' }, [
    el('label', { text: 'Runs at' }),
    input,
    el('div', { class: 'preset-row' }, [
      inMinutes('+1hr', 60, 'One hour from now'),
      inMinutes('+4hr', 240, 'Four hours from now'),
      el('span', { class: 'preset-sep' }),
      el('span', { class: 'preset-label', text: 'Tomorrow at' }),
      tomorrowAt,
      el('button', { type: 'button', class: 'btn small', text: 'Set', onclick: applyTomorrow }),
    ]),
    el('div', { class: 'hint', text: 'Your local time. It runs once, then stays in the list as history.' }),
    preview,
  ]);
}

/**
 * One form serves three jobs. Duplicating loads the source cron exactly as
 * editing does, so every field arrives filled in; only the name carries a
 * suffix, and Save creates a new cron instead of writing back to the source.
 */
async function renderForm(id, duplicateOf) {
  const sourceId = id ?? duplicateOf;
  const cron = sourceId ? await api(`/api/crons/${sourceId}`) : null;
  const errorBox = el('div', { class: 'error', hidden: 'hidden' });

  const inputs = {
    name: el('input', {
      type: 'text',
      value: duplicateOf ? `${cron.name} - Duplicate` : (cron?.name ?? ''),
      placeholder: 'Nightly changelog',
      maxlength: '120',
    }),
    description: el('input', {
      type: 'text',
      value: cron?.description ?? '',
      placeholder: 'What this run is for',
    }),
    cron: el('input', { type: 'text', class: 'mono', value: cron?.cron ?? '', placeholder: '0 9 * * *' }),
    workingDirectory: el('input', {
      type: 'text',
      class: 'mono',
      // New crons start at the home directory; editing shows whatever was saved.
      value: cron ? (cron.workingDirectory ?? '') : '~/',
      placeholder: '~/code/project',
      autocomplete: 'off',
      spellcheck: 'false',
    }),
    prompt: el('textarea', { placeholder: 'The prompt passed to claude -p' }),
    isActive: el('input', { type: 'checkbox' }),
  };
  inputs.prompt.value = cron?.prompt ?? '';
  inputs.isActive.checked = cron ? Boolean(cron.isActive) : true;

  const model = modelPicker(cron?.model ?? '');
  const effort = effortPicker(cron?.effort ?? '');
  const usageDelay = usageDelayPicker(cron?.usageDelay ?? null);

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const save = async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const payload = {
      name: inputs.name.value,
      description: inputs.description.value,
      cron: inputs.cron.value,
      workingDirectory: inputs.workingDirectory.value,
      model: model.read(),
      effort: effort.read(),
      usageDelay: usageDelay.read(),
      prompt: inputs.prompt.value,
      isActive: inputs.isActive.checked,
    };
    try {
      if (id) await api(`/api/crons/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/crons', { method: 'POST', body: JSON.stringify(payload) });
      toast(id ? 'Saved' : 'Cron created');
      location.hash = '#/';
    } catch (err) {
      showError(err.message);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${cron.name}"? Its log history is kept on disk.`)) return;
    try {
      await api(`/api/crons/${id}`, { method: 'DELETE' });
      toast('Cron deleted');
      location.hash = '#/';
    } catch (err) {
      showError(err.message);
    }
  };

  const field = (label, input, hint) =>
    el('div', { class: 'field' }, [
      el('label', { text: label }),
      input,
      hint ? el('div', { class: 'hint', text: hint }) : null,
    ]);

  view.replaceChildren(
    el('div', { class: 'breadcrumb' }, [el('a', { href: '#/', text: '← All crons' })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: id ? 'Edit cron' : duplicateOf ? 'Duplicate cron' : 'New cron' }),
        el('p', { class: 'sub', text: 'Runs claude -p with the prompt below on the schedule you set.' }),
      ]),
    ]),
    el('form', { class: 'card', onsubmit: save }, [
      errorBox,
      field('Name', inputs.name),
      field('Description', inputs.description),
      cronPicker(inputs.cron),
      directoryPicker(inputs.workingDirectory),
      model.field,
      effort.field,
      usageDelay.field,
      field('Prompt', inputs.prompt),
      el('label', { class: 'check' }, [inputs.isActive, 'Is Active']),
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn primary', type: 'submit', text: 'Save' }),
        el('a', { class: 'btn', href: '#/', text: 'Cancel' }),
        id ? el('a', { class: 'btn', href: `#/new/${id}`, text: 'Duplicate' }) : null,
        el('div', { class: 'spacer' }),
        id ? el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: remove }) : null,
      ]),
    ]),
  );
}

/**
 * The one-time execution form: the cron form with a date where the schedule
 * was, and everything else identical — working directory, model, effort, the
 * usage delay, the prompt.
 */
async function renderExecutionForm(id, duplicateOf) {
  const sourceId = id ?? duplicateOf;
  const execution = sourceId ? await api(`/api/executions/${sourceId}`) : null;
  const errorBox = el('div', { class: 'error', hidden: 'hidden' });

  /** An ISO time in the shape the datetime-local field wants: local, no zone. */
  const asFieldValue = (iso) => {
    const date = iso ? new Date(iso) : new Date(Date.now() + 3600000);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const inputs = {
    name: el('input', {
      type: 'text',
      value: duplicateOf ? `${execution.name} - Duplicate` : (execution?.name ?? ''),
      placeholder: 'Backfill the September invoices',
      maxlength: '120',
    }),
    description: el('input', {
      type: 'text',
      value: execution?.description ?? '',
      placeholder: 'What this run is for',
    }),
    scheduledAt: el('input', {
      type: 'datetime-local',
      class: 'mono',
      // A duplicate of something already run gets a fresh default rather than
      // the source's date, which is in the past and would fire on save.
      value: asFieldValue(duplicateOf ? null : execution?.scheduledAt),
    }),
    workingDirectory: el('input', {
      type: 'text',
      class: 'mono',
      value: execution ? (execution.workingDirectory ?? '') : '~/',
      placeholder: '~/code/project',
      autocomplete: 'off',
      spellcheck: 'false',
    }),
    prompt: el('textarea', { placeholder: 'The prompt passed to claude -p' }),
    isActive: el('input', { type: 'checkbox' }),
  };
  inputs.prompt.value = execution?.prompt ?? '';
  inputs.isActive.checked = execution ? Boolean(execution.isActive) : true;

  const model = modelPicker(execution?.model ?? '');
  const effort = effortPicker(execution?.effort ?? '');
  const usageDelay = usageDelayPicker(execution?.usageDelay ?? null);

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const save = async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const typed = inputs.scheduledAt.value.trim();
    const payload = {
      name: inputs.name.value,
      description: inputs.description.value,
      // Sent as a full instant rather than the field's bare local string, so
      // the server is not left guessing which clock it was typed on.
      scheduledAt: typed ? new Date(typed).toISOString() : '',
      workingDirectory: inputs.workingDirectory.value,
      model: model.read(),
      effort: effort.read(),
      usageDelay: usageDelay.read(),
      prompt: inputs.prompt.value,
      isActive: inputs.isActive.checked,
    };
    if (typed && Number.isNaN(new Date(typed).getTime())) return showError('Date and time is not a valid date.');
    try {
      if (id) await api(`/api/executions/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/executions', { method: 'POST', body: JSON.stringify(payload) });
      toast(id ? 'Saved' : 'One-time execution created');
      location.hash = '#/one-time';
    } catch (err) {
      showError(err.message);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${execution.name}"? Its log history is kept on disk.`)) return;
    try {
      await api(`/api/executions/${id}`, { method: 'DELETE' });
      toast('One-time execution deleted');
      location.hash = '#/one-time';
    } catch (err) {
      showError(err.message);
    }
  };

  const field = (label, input, hint) =>
    el('div', { class: 'field' }, [
      el('label', { text: label }),
      input,
      hint ? el('div', { class: 'hint', text: hint }) : null,
    ]);

  view.replaceChildren(
    el('div', { class: 'breadcrumb' }, [el('a', { href: '#/one-time', text: '← All one-time executions' })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: id ? 'Edit one-time execution' : duplicateOf ? 'Duplicate one-time execution' : 'New one-time execution' }),
        el('p', { class: 'sub', text: 'Runs claude -p with the prompt below, once, at the time you set.' }),
      ]),
    ]),
    el('form', { class: 'card', onsubmit: save }, [
      errorBox,
      field('Name', inputs.name),
      field('Description', inputs.description),
      scheduledAtPicker(inputs.scheduledAt),
      directoryPicker(inputs.workingDirectory),
      model.field,
      effort.field,
      usageDelay.field,
      field('Prompt', inputs.prompt),
      el('label', { class: 'check' }, [inputs.isActive, 'Is Active']),
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn primary', type: 'submit', text: 'Save' }),
        el('a', { class: 'btn', href: '#/one-time', text: 'Cancel' }),
        id ? el('a', { class: 'btn', href: `#/one-time/new/${id}`, text: 'Duplicate' }) : null,
        el('div', { class: 'spacer' }),
        id ? el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: remove }) : null,
      ]),
    ]),
  );
}

// ---- settings ---------------------------------------------------------

/**
 * There is nothing to count down to when Update now is pressed: the server first
 * holds the schedules and waits for any run to finish, and only then restarts.
 * So report the wait, and start the 5 second countdown once this page notices the
 * server is on a new commit — the same signal behind the "live - refresh window"
 * badge in the header.
 */
function watchUpdate(status, updateButton, updateLog) {
  clearTimeout(reloadTimer);
  clearTimeout(updateWatchTimer);

  const countdown = (secondsLeft) => {
    if (secondsLeft <= 0) {
      location.reload();
      return;
    }
    status.textContent = `Update applied. Reloading in ${secondsLeft}s…`;
    status.className = 'hint ok';
    reloadTimer = setTimeout(() => countdown(secondsLeft - 1), 1000);
  };

  const poll = async () => {
    await checkHealth();
    if (staleBuild) {
      countdown(5);
      return;
    }
    try {
      const pause = await api('/api/pause');
      if (!pause.paused) {
        // The pause was lifted without a restart: the script refused, or it gave
        // up waiting. Either way the update log has the reason.
        status.textContent = `Update did not proceed; schedules have resumed. See ${updateLog}`;
        status.className = 'hint warn';
        updateButton.textContent = 'Update now';
        updateButton.disabled = false;
        return;
      }
      const waiting = pause.runningCount;
      status.textContent = waiting
        ? `Waiting for ${waiting} cron${waiting === 1 ? '' : 's'} to finish executing before restarting…`
        : 'All crons idle. Waiting for the server to restart…';
      status.className = 'hint';
    } catch {
      // The restart drops connections; that is expected here.
      status.textContent = 'Restarting…';
      status.className = 'hint';
    }
    updateWatchTimer = setTimeout(poll, 2000);
  };

  poll();
}

async function renderSettings() {
  // Health comes along for the boot time: it is the one fact on this page that
  // belongs to the running process rather than to a file on disk.
  const [settings, config, health, notifications] = await Promise.all([
    api('/api/settings'),
    api('/api/config'),
    api('/api/health').catch(() => ({})),
    // One item's worth of payload; it is the counts either side of it we want.
    api('/api/notifications?limit=1').catch(() => ({})),
  ]);

  const status = el('div', { class: 'hint' });
  const checkButton = el('button', { class: 'btn small', text: 'Check for updates' });
  const updateButton = el('button', { class: 'btn primary', text: 'Update now', disabled: 'disabled' });

  const selfUpdate = el('input', { type: 'checkbox' });
  selfUpdate.checked = Boolean(settings.selfUpdate);

  // Tracked separately so rejecting a bad entry restores the value in force now,
  // not the one the page happened to load with.
  let intervalHours = Number(settings.updateCheckIntervalHours) || 24;
  const interval = el('input', { type: 'text', class: 'mono narrow', value: String(intervalHours) });

  /** Settings save as you change them; there is no Save button to forget. */
  const save = async (patch, description) => {
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
      toast(description);
    } catch (err) {
      toast(err.message, true);
    }
  };

  selfUpdate.addEventListener('change', () =>
    save({ selfUpdate: selfUpdate.checked }, selfUpdate.checked ? 'Self update on' : 'Self update off'),
  );

  interval.addEventListener('change', () => {
    const hours = Number(interval.value);
    if (!Number.isFinite(hours) || hours <= 0) {
      toast('Check interval must be a positive number of hours', true);
      interval.value = String(intervalHours);
      return;
    }
    intervalHours = hours;
    save({ updateCheckIntervalHours: hours }, `Checking every ${hours}h`);
  });

  const showCheck = (result) => {
    setUpdateBadge(Boolean(result.updatable), result.behind);
    if (result.updatable) {
      status.textContent = `Update available: ${result.behind} commit${result.behind === 1 ? '' : 's'} behind origin/main.`;
      status.className = 'hint warn';
      updateButton.disabled = false;
    } else {
      status.textContent = result.reason === 'already up to date' ? 'Up to date with origin/main.' : `No update: ${result.reason}`;
      status.className = result.reason === 'already up to date' ? 'hint ok' : 'hint warn';
      updateButton.disabled = true;
    }
  };

  const check = async () => {
    checkButton.disabled = true;
    checkButton.textContent = 'Checking…';
    status.textContent = 'Fetching origin/main…';
    status.className = 'hint';
    try {
      showCheck(await api('/api/update/check'));
    } catch (err) {
      status.textContent = err.message;
      status.className = 'hint warn';
    } finally {
      checkButton.disabled = false;
      checkButton.textContent = 'Check for updates';
    }
  };

  checkButton.addEventListener('click', check);

  updateButton.addEventListener('click', async () => {
    updateButton.disabled = true;
    updateButton.textContent = 'Updating…';
    try {
      const result = await api('/api/update/run', { method: 'POST' });
      toast(`Update started — progress in ${result.updateLog}`);
      status.textContent = 'Holding schedules…';
      status.className = 'hint';
      watchUpdate(status, updateButton, result.updateLog ?? settings.updateLog);
    } catch (err) {
      status.textContent = err.message;
      status.className = 'hint warn';
      updateButton.textContent = 'Update now';
      updateButton.disabled = false;
    }
  });

  const readOnly = (label, value) =>
    el('div', { class: 'field' }, [el('label', { text: label }), el('div', { class: 'path-value mono', text: value })]);

  view.replaceChildren(
    el('div', { class: 'breadcrumb' }, [el('a', { href: '#/', text: '← All crons' })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Settings' }),
        el('p', { class: 'sub', text: `Stored in ${settings.settingsFile}` }),
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'Self update' }),
      el('label', { class: 'check' }, [
        selfUpdate,
        'Check for updates once per interval and apply them automatically',
      ]),
      el('div', { class: 'hint warn' }, [
        'Every cron is paused while an update runs. ',
        'A trigger due in that window is missed, not queued. ',
        'With this off, the server still checks and shows an Update available badge in the header.',
      ]),
      el('div', { class: 'preset-row' }, [
        checkButton,
        updateButton,
        el('span', { class: 'preset-sep' }),
        el('span', { class: 'preset-label', text: 'Check every' }),
        interval,
        el('span', { class: 'preset-label', text: 'hours' }),
      ]),
      status,
      el('div', { class: 'hint' }, [
        'An update pulls ',
        el('span', { class: 'mono', text: 'origin/main' }),
        ' and restarts the service. Update now works even with self update off.',
      ]),
      el('div', { class: 'card-divider' }),
      el('h3', { text: 'Last check' }),
      readOnly('Last checked', settings.lastUpdateCheckAt ? `${fmtDateTime(settings.lastUpdateCheckAt)} (${fmtRelative(settings.lastUpdateCheckAt)})` : 'never'),
      readOnly(
        'Last update started',
        settings.lastUpdateLaunchedAt
          ? `${fmtDateTime(settings.lastUpdateLaunchedAt)}${settings.lastUpdateFromCommit ? `, from ${settings.lastUpdateFromCommit}` : ''}`
          : 'never',
      ),
      // An update restarts the service, so this says whether the last one landed.
      readOnly('Server last boot time', health.startedAt ? `${fmtDateTime(health.startedAt)} (${fmtRelative(health.startedAt)})` : 'unknown'),
      readOnly('Project folder', settings.projectDir),
      readOnly('Update log', settings.updateLog),
    ]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'Storage' }),
      readOnly('Storage root', config.storageRoot),
      readOnly('Crons', config.cronsDir),
      readOnly('One-time executions', config.executionsDir),
      readOnly('Logs', `${config.logsDir} (newest ${config.maxLogsPerCron} runs kept per cron)`),
      readOnly(
        'Notifications',
        Number.isFinite(notifications.total)
          ? `${config.notificationsDir} (${notifications.total} stored, ${notifications.unread} unread)`
          : config.notificationsDir,
      ),
      el('div', { class: 'hint' }, [
        'Every cron, every log line and every notification is a plain file under the storage root. ',
        'Editing a cron by hand is fine: the folder is watched. ',
        `The newest ${config.maxNotifications} notifications are kept, and the oldest are deleted as new ones arrive.`,
      ]),
    ]),
  );

  check();
}

// ---- logs -------------------------------------------------------------

const logsState = { cronId: null, kind: 'cron', selected: null, atBottom: true };

/**
 * Lifetime totals for one cron, drawn under its name on the logs page.
 *
 * These count completed runs only, and they outlive the logs below them — the
 * newest 50 runs are all that is kept on disk, while these keep counting. A
 * cron whose counters were read back from its logs therefore starts from
 * whatever had not been pruned yet.
 */
function statStrip(stats) {
  if (!stats) return null;

  const stat = (value, label, sub, tip) =>
    el('div', { class: 'stat', title: tip }, [
      el('div', { class: 'stat-value', text: value }),
      el('div', { class: 'stat-label', text: label }),
      el('div', { class: 'stat-sub', text: sub }),
    ]);

  const runs = stats.runs ?? 0;
  const perRun = runs > 0 ? `over ${runs} run${runs === 1 ? '' : 's'}` : 'no completed runs yet';

  return el('div', { class: 'stat-strip' }, [
    stat(
      runs.toLocaleString(),
      runs === 1 ? 'run completed' : 'runs completed',
      'lifetime',
      'Runs that finished successfully. Failed and stopped runs are not counted.',
    ),
    stat(
      fmtCost(stats.costUsd),
      'total cost',
      runs > 0 ? `${fmtCost(stats.averageCostUsd)} per run` : perRun,
      'What every successful run has cost, as the CLI reported it.',
    ),
    stat(
      Number.isFinite(stats.runtimeSeconds) ? fmtDuration(stats.runtimeSeconds * 1000) : '—',
      'total runtime',
      runs > 0 ? `${fmtDuration(stats.averageRuntimeSeconds * 1000)} per run` : perRun,
      'Wall-clock time across every successful run.',
    ),
  ]);
}

/**
 * The run history of one job, cron or one-time execution. Both write into the
 * same logs folder under their own id, so this page is the same page; only the
 * route it reads and the crumb it goes back to differ.
 */
async function renderLogs(id, kind = 'cron') {
  const base = kind === 'execution' ? 'executions' : 'crons';
  const [{ cron, logs, stats }, pause] = await Promise.all([api(`/api/${base}/${id}/logs`), api('/api/pause')]);
  logsState.cronId = id;
  logsState.kind = kind;

  // Default to the live run if there is one, else the newest run.
  if (!logsState.selected || !logs.some((log) => log.file === logsState.selected)) {
    logsState.selected = logs.find((log) => log.isRunning)?.file ?? logs[0]?.file ?? null;
  }

  const runList = el(
    'div',
    { class: 'run-list' },
    logs.length
      ? logs.map((log) =>
          el(
            'button',
            {
              class: `run-item${log.file === logsState.selected ? ' selected' : ''}`,
              onclick: () => {
                logsState.selected = log.file;
                logsState.atBottom = true;
                renderLogs(id, kind);
              },
            },
            [
              el('div', { class: 'when', text: fmtDateTime(log.startedAt) ?? log.file }),
              el('div', { class: 'meta' }, [
                log.isRunning
                  ? el('span', { class: 'pill running' }, [el('span', { class: 'led' }), 'live'])
                  : el('span', { text: fmtRelative(log.startedAt) }),
                el('span', { text: fmtBytes(log.size) }),
              ]),
            ],
          ),
        )
      : [el('div', { class: 'empty', text: 'No runs yet' })],
  );

  const body = el('pre', { class: 'log-body', text: logsState.selected ? 'Loading…' : 'Select a run' });
  body.addEventListener('scroll', () => {
    logsState.atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  });

  const liveBadge = el('span', { class: 'pill', text: '' });
  const selectedLog = logs.find((log) => log.file === logsState.selected);
  // Live runs tick from their start time; a finished run's total is read off the
  // log's closing line once the stream has replayed it.
  const runtimeEl = selectedLog?.isRunning
    ? el('span', {
        class: 'log-runtime',
        title: `Running since ${fmtDateTime(selectedLog.startedAt)}`,
        'data-runtime-start': selectedLog.startedAt,
        text: fmtElapsed(selectedLog.startedAt),
      })
    : el('span', { class: 'log-runtime', text: '' });

  const panel = el('div', { class: 'log-panel' }, [
    el('div', { class: 'log-head' }, [
      el('span', { class: 'mono', text: selectedLog ? (fmtDateTime(selectedLog.startedAt) ?? selectedLog.file) : '—' }),
      liveBadge,
      runtimeEl,
      el('div', { class: 'spacer' }),
      selectedLog
        ? el('a', {
            class: 'btn small',
            href: `/api/${base}/${id}/logs/${encodeURIComponent(selectedLog.file)}`,
            target: '_blank',
            text: 'Raw',
          })
        : null,
    ]),
    body,
  ]);

  const scheduleLine =
    kind === 'execution'
      ? `Scheduled for ${fmtDateTime(cron.scheduledAt) ?? 'an unreadable date'}.`
      : '';

  view.replaceChildren(
    el('div', { class: 'breadcrumb' }, [
      kind === 'execution'
        ? el('a', { href: '#/one-time', text: '← All one-time executions' })
        : el('a', { href: '#/', text: '← All crons' }),
    ]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: `Logs · ${cron.name}` }),
        el('p', {
          class: 'sub',
          text: `${scheduleLine}${scheduleLine ? ' ' : ''}${logs.length} run${logs.length === 1 ? '' : 's'} kept, newest first. Oldest are pruned past 50.`,
        }),
        statStrip(stats),
      ]),
      el('div', { class: 'row-actions' }, [
        kind === 'execution'
          ? el('a', { class: 'btn', href: `#/one-time/edit/${cron.id}`, text: 'Edit execution' })
          : el('a', { class: 'btn', href: `#/edit/${cron.id}`, text: 'Edit cron' }),
        runControl(cron, {
          pause,
          onStarted: () => {
            logsState.selected = null; // jump to the new run's log
          },
        }),
      ]),
    ]),
    el('div', { class: 'logs-layout' }, [runList, panel]),
  );

  if (logsState.selected) openLogStream(id, logsState.selected, body, liveBadge, runtimeEl, base);
}

/**
 * The run length a finished log reports on its own closing line, e.g.
 * "--- succeeded after 12.3s ---". Null while the log has no closing line yet,
 * which is every log that is still being written.
 */
function durationFromLog(text) {
  const matches = [...text.matchAll(/^--- \w+ after ([\d.]+)s/gm)];
  const last = matches.at(-1);
  return last ? Number(last[1]) * 1000 : null;
}

/** Streams one log file into the pre element, appending chunks as they arrive. */
function openLogStream(cronId, file, body, liveBadge, runtimeEl, base = 'crons') {
  closeLogStream();
  body.textContent = '';
  liveBadge.textContent = 'streaming';
  liveBadge.className = 'pill running';

  const stream = new EventSource(`/api/${base}/${cronId}/logs/${encodeURIComponent(file)}/stream`);
  logStream = stream;

  stream.addEventListener('chunk', (event) => {
    body.append(JSON.parse(event.data).text);
    if (logsState.atBottom) body.scrollTop = body.scrollHeight;
  });

  stream.addEventListener('done', () => {
    liveBadge.textContent = 'finished';
    liveBadge.className = 'pill';
    if (runtimeEl) {
      // The clock stops here: whatever the run took is now written in the log.
      delete runtimeEl.dataset.runtimeStart;
      const ms = durationFromLog(body.textContent);
      runtimeEl.textContent = ms === null ? '' : fmtDuration(ms);
    }
    if (!body.textContent) body.textContent = '(empty log)';
    closeLogStream();
  });

  stream.onerror = () => {
    liveBadge.textContent = 'stream lost';
    liveBadge.className = 'pill failed';
    closeLogStream();
  };
}

function closeLogStream() {
  logStream?.close();
  logStream = null;
}

// ---- routing ----------------------------------------------------------

/**
 * The hash, split into what it is asking for.
 *
 * One-time executions hang off a `one-time` prefix — `#/one-time/edit/:id` —
 * so the two kinds have parallel URLs and every page of either is linkable.
 */
function parseHash() {
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
  if (parts[0] === 'one-time') return { kind: 'execution', section: parts[1] ?? 'list', id: parts[2] ?? null };
  return { kind: 'cron', section: parts[0] ?? 'list', id: parts[1] ?? null };
}

async function route() {
  closeLogStream();
  clearTimeout(modelPollTimer);
  clearTimeout(reloadTimer);
  clearTimeout(updateWatchTimer);
  const { kind, section, id } = parseHash();
  try {
    if (section === 'settings') await renderSettings();
    else if (kind === 'execution') {
      if (section === 'new') await renderExecutionForm(null, id || null);
      else if (section === 'edit' && id) await renderExecutionForm(id);
      else if (section === 'logs' && id) await renderLogs(id, 'execution');
      else await renderHome('executions');
    } else if (section === 'new') await renderForm(null, id || null);
    else if (section === 'edit' && id) await renderForm(id);
    else if (section === 'logs' && id) await renderLogs(id);
    else await renderHome('crons');
  } catch (err) {
    view.replaceChildren(
      el('div', { class: 'breadcrumb' }, [el('a', { href: '#/', text: '← All crons' })]),
      el('div', { class: 'error', text: err.message }),
    );
  }
}

/** Re-renders the current view when the server reports activity. */
function refreshCurrentView() {
  const { kind, section, id } = parseHash();
  if (section === 'logs' && id) {
    // Keep the open stream; only the run list and header need refreshing.
    renderLogs(id, kind).catch(() => {});
  } else if (section === 'list') {
    renderHome(kind === 'execution' ? 'executions' : 'crons').catch(() => {});
  }
}

function connectEvents() {
  const events = new EventSource('/api/events');

  events.addEventListener('hello', () => {
    setConnState();
    checkHealth();
    // Also the reconnect path: a page that dropped missed samples, and this is
    // what fills the chart back in.
    loadSystem();
  });

  events.addEventListener('system:sample', (event) => pushSystemSample(JSON.parse(event.data)));

  events.addEventListener('notification:new', (event) => {
    const { notification, unread } = JSON.parse(event.data);
    setBellBadge(unread);
    prependNotification(notification);
  });

  // Another tab read something; this one's badge is now wrong.
  events.addEventListener('notification:read', (event) => setBellBadge(JSON.parse(event.data).unread));

  // A machine alert is worth interrupting for; it is also in the drawer.
  events.addEventListener('system:alert', (event) => {
    const { metric, label, summary } = JSON.parse(event.data);
    toast(`${label}: ${summary}`, true, `system-alert:${metric}`);
  });

  for (const type of ['crons:changed', 'run:started', 'run:finished', 'run:skipped', 'run:stopping', 'run:delayed', 'run:released', 'run:dropped']) {
    events.addEventListener(type, (event) => {
      const payload = JSON.parse(event.data);
      // Matches the wording the server writes into the notification drawer.
      const named = payload.kind === 'execution' ? `one-time "${payload.cronName}"` : `"${payload.cronName}"`;
      // Matches the drawer: a run with no footer has no duration to report.
      if (type === 'run:finished') {
        toast(
          Number.isFinite(payload.seconds)
            ? `${named} ${payload.status} in ${payload.seconds}s`
            : `${named} ${payload.status}`,
        );
      }
      if (type === 'run:delayed') {
        const when = payload.resumeAt ? ` Starts ${fmtRelative(payload.resumeAt)}.` : '';
        toast(`${named} is waiting on ${delayNames(payload)}.${when}`, true);
      }
      // Only the release that actually starts the run is worth a toast; a
      // cancelled or dropped one already reported itself where it happened.
      if (type === 'run:released' && payload.ran) toast(`${named} usage cleared, starting now`);
      if (type === 'run:dropped') {
        // A pause is missed time, not queued time, so the count says how many
        // runs this cron has now lost rather than how many are waiting.
        const sofar = payload.droppedCount > 1 ? ` (${payload.droppedCount} missed so far)` : '';
        toast(`${named} trigger dropped: ${payload.reason}${sofar}`, true, `dropped:${payload.cronId}`);
      }
      if (type === 'run:skipped') {
        toast(payload.reason ? `${named} skipped: ${payload.reason}` : `${named} was still running; trigger skipped`, true);
      }
      refreshCurrentView();
    });
  }

  // Pause and update progress: the badges and the sub line both come from it.
  events.addEventListener('update:availability', (event) => {
    const { updateAvailable, updateBehind } = JSON.parse(event.data);
    setUpdateBadge(Boolean(updateAvailable), updateBehind);
  });
  events.addEventListener('pause:changed', () => refreshCurrentView());
  events.addEventListener('update:waiting', () => refreshCurrentView());
  events.addEventListener('update:launched', () => refreshCurrentView());
  events.addEventListener('update:abandoned', (event) => {
    const { runningCount } = JSON.parse(event.data);
    toast(`Update gave up waiting on ${runningCount} run(s); schedules resumed`, true);
    refreshCurrentView();
  });
  events.addEventListener('update:failed', (event) => {
    const { code } = JSON.parse(event.data);
    toast(`Update script failed (exit ${code}); schedules resumed`, true);
    refreshCurrentView();
  });

  // Cron files changed on disk outside the app: one toast per file, then redraw.
  // A one-time execution whose trigger was missed: the catch-up is starting it
  // now, which is worth saying out loud since nobody asked for it just then.
  events.addEventListener('execution:overdue', (event) => {
    const payload = JSON.parse(event.data);
    toast(`One-time "${payload.cronName}" missed its trigger by ${payload.lateBy}; running now`);
    refreshCurrentView();
  });

  events.addEventListener('crons:files-changed', (event) => {
    const { added = [], updated = [], removed = [], broken = [], repaired = [] } = JSON.parse(event.data);
    for (const name of added) toast(`Cron file added: "${name}", now scheduled`);
    for (const name of updated) toast(`Cron file updated: "${name}", rescheduled`);
    for (const name of removed) toast(`Cron file deleted: "${name}", unscheduled`, true);
    for (const item of broken) toast(`${item.file} is not valid JSON; still running its last saved version`, true);
    for (const name of repaired) toast(`Cron file fixed: "${name}", rescheduled`);
    refreshCurrentView();
  });

  events.onerror = () => {
    connEl.textContent = 'reconnecting';
    connEl.className = 'conn down';
  };
}

/**
 * The header offer. Shown whenever main is behind, whether or not the server is
 * allowed to apply it itself, and clicking through goes to Settings.
 */
function setUpdateBadge(available, behind = 0) {
  if (!updateBadgeEl) return;
  updateBadgeEl.hidden = !available;
  if (!available) return;
  const commits = behind ? `${behind} commit${behind === 1 ? '' : 's'} behind origin/main. ` : '';
  updateBadgeEl.title = `${commits}Open Settings to update.`;
}

// ---- notifications ----------------------------------------------------

/**
 * The bell, and the drawer behind it.
 *
 * Toasts are gone in a few seconds and nobody watches a dashboard all day, so
 * the server writes the same events down and this reads them back. Unread is
 * the only state that matters here: a run that succeeded arrives already read,
 * and what is left is what a person would have wanted to be told.
 */
const bellEl = document.getElementById('bell');
const bellBadgeEl = document.getElementById('bell-badge');
const drawerEl = document.getElementById('drawer');
const drawerListEl = document.getElementById('drawer-list');
const drawerBackdropEl = document.getElementById('drawer-backdrop');
const drawerCloseEl = document.getElementById('drawer-close');

/** On screen this long and it counts as read. */
const READ_AFTER_MS = 3000;

let drawerOpen = false;
let nextBefore = null; // cursor for the next page; null once the end is reached
let loadingPage = false;
const drawnIds = new Set(); // a notification arriving as both a page and an event
const readTimers = new Map(); // id -> the timer counting out its three seconds
const pendingRead = new Set(); // seen, not yet reported to the server
let readFlushTimer = null;
let viewObserver = null; // watches items for the three-second rule
let moreObserver = null; // watches the end of the list for the next page
let sentinelEl = null;

function setBellBadge(count) {
  if (!bellBadgeEl) return;
  const unread = Number(count) || 0;
  bellBadgeEl.hidden = unread === 0;
  bellBadgeEl.textContent = unread > 99 ? '99+' : String(unread);
  bellEl?.setAttribute('title', unread ? `Notifications — ${unread} unread` : 'Notifications');
}

/** The coloured dot: what kind of thing this was, at a glance. */
function noteKindClass(kind) {
  if (kind === 'run-failed' || kind === 'cron-broken') return 'bad';
  if (kind === 'delayed' || kind === 'update' || kind === 'system') return 'warn';
  return 'plain';
}

function renderNotification(record) {
  const meta = `${fmtRelative(record.at)} · ${fmtDateTime(record.at)}`;
  const node = el('div', { class: `note ${record.read ? '' : 'unread'}`.trim(), 'data-id': record.id }, [
    el('span', { class: `note-dot ${noteKindClass(record.kind)}` }),
    el('div', { class: 'note-body' }, [
      el('div', { class: 'note-message', text: record.message }),
      el('div', { class: 'note-meta', text: meta }),
    ]),
  ]);
  // A notification about a job is a shortcut to that job's runs, on whichever
  // of the two logs pages it belongs to.
  if (record.cronId) {
    node.classList.add('linked');
    node.addEventListener('click', () => {
      closeDrawer();
      location.hash = record.jobKind === 'execution' ? `#/one-time/logs/${record.cronId}` : `#/logs/${record.cronId}`;
    });
  }
  return node;
}

/** Reports what has been seen, in one request rather than one per item. */
function flushRead() {
  clearTimeout(readFlushTimer);
  readFlushTimer = setTimeout(async () => {
    const ids = [...pendingRead];
    if (!ids.length) return;
    pendingRead.clear();
    try {
      const result = await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids }) });
      setBellBadge(result.unread);
    } catch {
      // Put them back: the next flush tries again, and the worst case is that
      // something stays unread rather than being marked read without proof.
      for (const id of ids) pendingRead.add(id);
    }
  }, 400);
}

/** One item has now been on screen long enough. */
function markSeen(id, node) {
  node.classList.remove('unread');
  viewObserver?.unobserve(node);
  pendingRead.add(id);
  flushRead();
}

/** Only unread items are watched; the rest have nothing left to change. */
function observeItem(node, record) {
  if (record.read || !viewObserver) return;
  viewObserver.observe(node);
}

async function loadNextPage() {
  if (loadingPage || !drawerOpen) return;
  loadingPage = true;
  try {
    const query = nextBefore ? `?before=${encodeURIComponent(nextBefore)}` : '';
    const page = await api(`/api/notifications${query}`);
    setBellBadge(page.unread);
    for (const record of page.items) {
      if (drawnIds.has(record.id)) continue;
      drawnIds.add(record.id);
      const node = renderNotification(record);
      drawerListEl.insertBefore(node, sentinelEl);
      observeItem(node, record);
    }
    nextBefore = page.nextBefore;
    if (!drawnIds.size) {
      drawerListEl.insertBefore(el('div', { class: 'drawer-empty', text: 'Nothing yet.' }), sentinelEl);
    }
    // A short first page leaves the sentinel on screen, and an observer that is
    // already intersecting will not fire again — so ask once more by hand.
    if (nextBefore) {
      requestAnimationFrame(() => {
        const list = drawerListEl.getBoundingClientRect();
        const end = sentinelEl.getBoundingClientRect();
        if (end.top <= list.bottom + 120) loadNextPage();
      });
    }
  } catch (err) {
    drawerListEl.insertBefore(el('div', { class: 'drawer-empty', text: err.message }), sentinelEl);
  } finally {
    loadingPage = false;
  }
}

/** A notification that lands while the drawer is open, from the event stream. */
function prependNotification(record) {
  if (!drawerOpen || drawnIds.has(record.id)) return;
  // Only when the reader is at the top. Inserting above where they are reading
  // would move the list under them.
  if (drawerListEl.scrollTop > 40) return;
  drawnIds.add(record.id);
  drawerListEl.querySelector('.drawer-empty')?.remove();
  const node = renderNotification(record);
  drawerListEl.prepend(node);
  observeItem(node, record);
}

function openDrawer() {
  if (drawerOpen) return;
  drawerOpen = true;
  drawnIds.clear();
  nextBefore = null;
  sentinelEl = el('div', { class: 'drawer-sentinel' });
  drawerListEl.replaceChildren(sentinelEl);
  drawerEl.classList.add('open');
  drawerEl.setAttribute('aria-hidden', 'false');
  drawerBackdropEl.classList.add('open');

  viewObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.id;
        if (entry.isIntersecting) {
          if (readTimers.has(id)) continue;
          readTimers.set(id, setTimeout(() => {
            readTimers.delete(id);
            markSeen(id, entry.target);
          }, READ_AFTER_MS));
        } else {
          // Scrolled past before the three seconds were up: it does not count.
          clearTimeout(readTimers.get(id));
          readTimers.delete(id);
        }
      }
    },
    { root: drawerListEl, threshold: 0.6 },
  );

  moreObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNextPage();
    },
    { root: drawerListEl, rootMargin: '120px' },
  );
  moreObserver.observe(sentinelEl);

  loadNextPage();
  drawerListEl.focus({ preventScroll: true });
}

function closeDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  drawerEl.classList.remove('open');
  drawerEl.setAttribute('aria-hidden', 'true');
  drawerBackdropEl.classList.remove('open');
  viewObserver?.disconnect();
  moreObserver?.disconnect();
  viewObserver = null;
  moreObserver = null;
  for (const timer of readTimers.values()) clearTimeout(timer);
  readTimers.clear();
  // Anything that earned its three seconds still counts, even if the drawer
  // closed before the debounce ran.
  if (pendingRead.size) flushRead();
}

bellEl?.addEventListener('click', () => (drawerOpen ? closeDrawer() : openDrawer()));
drawerCloseEl?.addEventListener('click', closeDrawer);
drawerBackdropEl?.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});

// ---- machine stats ----------------------------------------------------

/**
 * The meters left of the subscription ones: how busy this machine is while it
 * runs your crons — CPU, memory, storage throughput, and how full the disk is.
 *
 * The server samples on its own timer and pushes each sample down /api/events,
 * so the page keeps its own copy of the window and appends to it. Nothing here
 * polls.
 */
let systemConfig = null; // metric metadata and the window length, from the server
let systemSamples = []; // the retained window, oldest first
let systemDetail = {}; // byte counts behind the latest percentages
let systemNotes = {}; // why a metric is reporting nothing, by id
/** Nodes are built once and written to in place: rebuilding under the cursor would close an open chart. */
const systemNodes = new Map();

const SPARK_WIDTH = 228;
const SPARK_HEIGHT = 52;
const SPARK_TOP = 3;
const SPARK_BOTTOM = SPARK_HEIGHT - 3;

/**
 * What the bar is full of. A percentage fills against 100. A rate has no
 * ceiling, so it fills against the busiest moment still in the window — never
 * less than the metric's floor, or an idle disk would draw a full bar off a
 * 0.2 MB/s blip.
 */
function metricScale(metric) {
  if (metric.kind !== 'rate') return 100;
  let peak = metric.minScale ?? 1;
  for (const sample of systemSamples) {
    const value = sample[metric.id];
    if (Number.isFinite(value) && value > peak) peak = value;
  }
  return peak;
}

function fmtMetricValue(metric, value) {
  if (!Number.isFinite(value)) return '—';
  if (metric.kind === 'rate') return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${metric.unit}`;
  return `${Math.round(value)}${metric.unit}`;
}

/** The API hands out its own severity for usage; here the thresholds are ours. */
function metricSeverity(metric, value) {
  if (!Number.isFinite(value) || metric.kind !== 'percent') return 'normal';
  if (Number.isFinite(metric.critical) && value >= metric.critical) return 'critical';
  if (Number.isFinite(metric.warning) && value >= metric.warning) return 'warning';
  return 'normal';
}

/**
 * The average and the peak across the window, ignoring gaps. `now` is the
 * newest sample rather than the newest reading: if the last sample could not
 * read this metric, the chart says so instead of repeating an older number.
 */
function metricSummary(metric) {
  const values = systemSamples.map((sample) => sample[metric.id]).filter((value) => Number.isFinite(value));
  if (!values.length) return { now: null, average: null, peak: null };
  return {
    now: systemSamples.at(-1)?.[metric.id] ?? null,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    peak: Math.max(...values),
  };
}

/**
 * The 15-minute line, as an SVG path.
 *
 * Points are placed by their timestamp rather than their position in the array,
 * so a gap in the samples — a restart, a metric the platform could not read —
 * shows as a gap rather than being drawn through. Each run of readings is its
 * own subpath for the same reason.
 */
function sparkPaths(metric) {
  const scale = metricScale(metric);
  const windowMs = systemConfig?.windowMs ?? 15 * 60 * 1000;
  const endsAt = Date.now();
  const x = (iso) => {
    const at = Date.parse(iso);
    const ratio = (at - (endsAt - windowMs)) / windowMs;
    return Math.max(0, Math.min(1, ratio)) * SPARK_WIDTH;
  };
  const y = (value) => SPARK_BOTTOM - (Math.min(value, scale) / scale) * (SPARK_BOTTOM - SPARK_TOP);

  const runs = [];
  let run = [];
  for (const sample of systemSamples) {
    const value = sample[metric.id];
    if (!Number.isFinite(value)) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    run.push([x(sample.at), y(value)]);
  }
  if (run.length) runs.push(run);

  const point = ([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`;
  const line = runs
    .map((points) => points.map((p, index) => `${index ? 'L' : 'M'}${point(p)}`).join(' '))
    .join(' ');
  const area = runs
    .filter((points) => points.length > 1)
    .map(
      (points) =>
        `M${points[0][0].toFixed(1)} ${SPARK_BOTTOM} ` +
        points.map((p) => `L${point(p)}`).join(' ') +
        ` L${points.at(-1)[0].toFixed(1)} ${SPARK_BOTTOM} Z`,
    )
    .join(' ');
  return { line, area, scale };
}

/** The line under the chart: what is actually behind the percentage. */
function metricDetailText(metric) {
  const detail = systemDetail?.[metric.id];
  if (!detail) return null;
  if (metric.id === 'cpu') {
    const load = Number.isFinite(detail.loadAverage) ? ` · load ${detail.loadAverage}` : '';
    return `${detail.cores} cores${load}`;
  }
  if (metric.id === 'memory') return `${fmtBytes(detail.usedBytes)} of ${fmtBytes(detail.totalBytes)} in use`;
  if (metric.id === 'io') {
    return Number.isFinite(detail.transfersPerSecond) ? `${detail.transfersPerSecond} transfers/s` : null;
  }
  if (metric.id === 'disk') return `${fmtBytes(detail.usedBytes)} used · ${fmtBytes(detail.freeBytes)} free`;
  return null;
}

/** One meter, plus the chart that opens under it on hover. */
function buildSystemMeter(metric) {
  const fill = el('div', { class: 'usage-fill' });
  const pct = el('span', { class: 'usage-pct', text: '—' });
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('class', 'spark-area');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('class', 'spark-line');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.append(area, line);

  const top = el('span', { class: 'spark-top', text: '' });
  const now = el('dd', { text: '—' });
  const average = el('dd', { text: '—' });
  const peak = el('dd', { text: '—' });
  const detail = el('div', { class: 'pop-detail', text: '' });
  const note = el('div', { class: 'pop-note', text: '' });

  const pop = el('div', { class: 'metric-pop' }, [
    el('div', { class: 'pop-title' }, [el('span', { text: metric.title }), top]),
    el('div', { class: 'pop-sub', text: metric.detail }),
    svg,
    el('div', { class: 'pop-axis' }, [el('span', { class: 'pop-span' }), el('span', { text: 'now' })]),
    el('dl', { class: 'pop-stats' }, [
      el('div', {}, [el('dt', { text: 'Now' }), now]),
      el('div', {}, [el('dt', { text: 'Avg' }), average]),
      el('div', {}, [el('dt', { text: 'Peak' }), peak]),
    ]),
    detail,
    note,
  ]);

  const root = el('div', { class: 'usage-meter system-meter' }, [
    el('div', { class: 'usage-head' }, [el('span', { text: metric.label }), pct]),
    el('div', { class: 'usage-track' }, [fill]),
    pop,
  ]);

  pop.querySelector('.pop-span').textContent = `${Math.round((systemConfig?.windowMs ?? 900000) / 60000)}m ago`;
  systemNodes.set(metric.id, { root, fill, pct, area, line, top, now, average, peak, detail, note });
  return root;
}

/** Writes the current reading into nodes that already exist. */
function updateSystemMeters() {
  if (!systemConfig) return;
  const latest = systemSamples.at(-1) ?? null;
  systemEl.hidden = !latest;
  if (!latest) return;

  for (const metric of systemConfig.metrics) {
    const nodes = systemNodes.get(metric.id);
    if (!nodes) continue;
    const value = latest[metric.id];
    const summary = metricSummary(metric);
    const { line, area, scale } = sparkPaths(metric);

    nodes.root.className = `usage-meter system-meter ${metricSeverity(metric, value)}`;
    nodes.pct.textContent = fmtMetricValue(metric, value);
    nodes.fill.style.width = `${Number.isFinite(value) ? Math.max(0, Math.min(100, (value / scale) * 100)) : 0}%`;
    nodes.line.setAttribute('d', line);
    nodes.area.setAttribute('d', area);
    // A rate's chart is only readable if it says what the top of it means.
    nodes.top.textContent = metric.kind === 'rate' ? `top ${fmtMetricValue(metric, scale)}` : '100%';
    nodes.now.textContent = fmtMetricValue(metric, summary.now);
    nodes.average.textContent = fmtMetricValue(metric, summary.average);
    nodes.peak.textContent = fmtMetricValue(metric, summary.peak);

    const detailText = metricDetailText(metric);
    nodes.detail.textContent = detailText ?? '';
    nodes.detail.hidden = !detailText;
    const note = systemNotes?.[metric.id] ?? null;
    nodes.note.textContent = note ?? '';
    nodes.note.hidden = !note;
  }
}

/**
 * Loads the window from the server and builds the meters.
 *
 * Called on every SSE hello, which covers both the first connection and every
 * reconnection after one — a page that was disconnected missed samples, and
 * this is what fills them back in rather than leaving a hole in the chart.
 */
async function loadSystem() {
  if (!systemEl) return;
  try {
    const state = await api('/api/system');
    if (!state.enabled) {
      systemEl.hidden = true;
      return;
    }
    const firstLoad = !systemConfig;
    systemConfig = state;
    systemSamples = state.samples ?? [];
    systemDetail = state.detail ?? {};
    systemNotes = state.notes ?? {};
    if (firstLoad) {
      systemEl.replaceChildren(...state.metrics.map(buildSystemMeter));
    }
    updateSystemMeters();
  } catch {
    /* the header simply carries no machine meters */
  }
}

/** One sample off the event stream, appended and trimmed to the window. */
function pushSystemSample(payload) {
  if (!systemConfig || !payload?.sample) return;
  systemSamples.push(payload.sample);
  systemDetail = payload.detail ?? systemDetail;
  systemNotes = payload.notes ?? systemNotes;
  const cutoff = Date.now() - systemConfig.windowMs;
  while (systemSamples.length && Date.parse(systemSamples[0].at) < cutoff) systemSamples.shift();
  updateSystemMeters();
}

/** A clock, small enough to sit level with the meter labels. */
const CLOCK_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round"><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.4 1.6" /></svg>';

/**
 * The clock to the left of the meters: when these numbers were pulled. The
 * server answers from its last lookup, so without this the header gives no way
 * to tell a reading taken a minute ago from one taken an hour ago.
 */
function readStamp(usage) {
  const tip = usage?.checkedAt
    ? [
        `Usage last read ${fmtRelative(usage.checkedAt)}`,
        fmtDateTime(usage.checkedAt),
        usage.reason ? `Refresh is waiting: ${usage.reason}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : 'Usage has not been read yet';
  return el('span', { class: `usage-stamp${usage?.stale ? ' stale' : ''}`, 'data-tip': tip, html: CLOCK_ICON });
}

/**
 * Subscription usage, one meter per limit window the account reports. The
 * windows are whatever the server passes through, so a limit added to the plan
 * later shows up here without a change.
 *
 * The server answers every poll from its last lookup, so these are last-known
 * numbers whenever a refresh fails or the reading came off disk at startup. In
 * that case the meters dim and say when they were read rather than vanishing.
 */
function setUsage(usage) {
  if (!usageEl) return;
  const windows = usage?.windows ?? [];
  // Nothing to report is not worth a red header; the meters simply go away.
  usageEl.hidden = !windows.length;
  usageEl.replaceChildren();

  const asOf = usage?.stale && usage.checkedAt ? `Last read ${fmtRelative(usage.checkedAt)}` : null;
  const why = usage?.stale && usage.reason ? `Refresh is waiting: ${usage.reason}` : null;
  if (windows.length) usageEl.append(readStamp(usage));

  for (const window of windows) {
    const resets = window.resetsAt ? `Resets ${fmtRelative(window.resetsAt)} (${fmtDateTime(window.resetsAt)})` : null;
    // Credits are a spending cap rather than a rolling window, so they carry a
    // note saying which kind of limit the reset date belongs to.
    const tip = [`${window.detail}`, `${window.usedPercent}% used`, resets, window.note, asOf, why]
      .filter(Boolean)
      .join('\n');
    usageEl.append(
      el('div', { class: `usage-meter ${window.severity}${usage?.stale ? ' stale' : ''}`, 'data-tip': tip }, [
        el('div', { class: 'usage-head' }, [
          el('span', { text: window.label }),
          el('span', { class: 'usage-pct', text: `${Math.round(window.usedPercent)}%` }),
        ]),
        el('div', { class: 'usage-track' }, [el('div', { class: 'usage-fill', style: `width: ${window.usedPercent}%` })]),
      ]),
    );
  }
}

/** Live, or live-but-out-of-date once the server has moved to another commit. */
function setConnState() {
  if (staleBuild) {
    connEl.textContent = 'live - refresh window';
    connEl.className = 'conn stale';
    connEl.title = `This page loaded from ${loadedCommit}; the server now runs newer code. Reload to catch up.`;
    return;
  }
  connEl.textContent = 'live';
  connEl.className = 'conn live';
  connEl.title = 'Live connection';
}

/** Notices when the running commit changes, which means an update landed. */
async function checkHealth() {
  try {
    const health = await api('/api/health');
    setUpdateBadge(Boolean(health.updateAvailable), health.updateBehind);
    setBellBadge(health.unreadNotifications);
    setUsage(health.usage);
    if (!health.commit) return; // not a git checkout, nothing to compare
    if (!loadedCommit) loadedCommit = health.commit;
    else if (health.commit !== loadedCommit) staleBuild = true;
    setConnState();
  } catch {
    /* the SSE error handler already reports a lost connection */
  }
}

window.addEventListener('hashchange', route);
// Live run clocks, wherever they are on the page.
setInterval(tickRuntimes, 1000);
// Cheap, and a restart is exactly when the running commit changes.
setInterval(checkHealth, 20000);
// Keeps "3m ago" / "in 20m" honest without hammering the API.
// Keeps "in 20m" honest on whichever list is open. Both tabs are a `list`
// section, so this has to read the hash the way the router does rather than
// assume the home page is the one with nothing after the slash.
setInterval(() => {
  if (parseHash().section === 'list') refreshCurrentView();
}, 15000);

checkHealth();
connectEvents();
route();
