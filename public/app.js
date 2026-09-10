const view = document.getElementById('view');
const connEl = document.getElementById('conn');
const storageEl = document.getElementById('storage');
const toastsEl = document.getElementById('toasts');

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

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Toasts stack, so several changes landing at once stay readable. */
function toast(message, bad = false) {
  const node = el('div', { class: bad ? 'toast bad' : 'toast', text: message });
  toastsEl.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  }, bad ? 6000 : 3500);
  // Never let a burst pile up past a screenful.
  while (toastsEl.children.length > 5) toastsEl.firstElementChild.remove();
}

/**
 * A live run keeps its running badge through a pause and picks up the paused
 * badge when it finishes. A deactivated cron stays deactivated: a pause does
 * not change it, and lifting the pause will not arm it.
 */
function statusPill(cron, pause) {
  if (cron.isRunning) return el('span', { class: 'pill running' }, [el('span', { class: 'led' }), 'running']);
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
          await api(`/api/crons/${cron.id}/stop`, { method: 'POST' });
          toast(`Stopping "${cron.name}"`);
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
            : `All crons are paused ${pause.label}. Cancel the pause to run one.`,
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
        await api(`/api/crons/${cron.id}/run`, { method: 'POST' });
        onStarted?.();
        toast(`Started "${cron.name}"`);
      } catch (err) {
        toast(err.message, true);
        event.target.disabled = false;
      }
    },
  });
}

// ---- home -------------------------------------------------------------

async function renderHome() {
  const [crons, pause] = await Promise.all([api('/api/crons'), api('/api/pause')]);

  const armed = crons.filter((c) => c.isActive).length;
  let sub;
  if (!crons.length) sub = 'Nothing scheduled yet';
  else if (pause.paused && pause.mode === 'update') {
    sub = pause.runningCount
      ? `Paused for update — waiting for ${pause.runningCount} run${pause.runningCount === 1 ? '' : 's'} to finish`
      : 'Paused for update — restarting';
  } else if (pause.paused) {
    sub = pause.until
      ? `${armed} armed of ${crons.length} — paused ${pause.label}, resumes ${fmtRelative(pause.until)}`
      : `${armed} armed of ${crons.length} — paused ${pause.label}`;
  } else sub = `${armed} armed of ${crons.length}`;

  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [el('h1', { text: 'Crons' }), el('p', { class: 'sub', text: sub })]),
    el('div', { class: 'head-actions' }, [
      pauseControl(pause, pause.options ?? [], () => renderHome().catch(() => {})),
      el('a', { class: 'btn primary', href: '#/new', text: '+ New cron' }),
    ]),
  ]);

  if (!crons.length) {
    view.replaceChildren(
      head,
      el('div', { class: 'panel' }, [
        el('div', { class: 'empty' }, [
          el('p', { text: 'No crons yet.' }),
          el('a', { class: 'btn primary', href: '#/new', text: 'Create your first cron' }),
        ]),
      ]),
    );
    return;
  }

  const rows = crons.map((cron) => {
    return el('tr', {}, [
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
      el('td', { class: 'hide-sm' }, [outcomePill(cron.lastRunStatus)]),
      el('td', { class: 'hide-sm' }, [
        cron.nextRunAt
          ? el('div', {}, [
              el('div', { text: fmtRelative(cron.nextRunAt) }),
              el('div', { class: 'cron-desc', text: fmtDateTime(cron.nextRunAt) }),
            ])
          : // Paused means the schedule is not registered, so there is no next
            // fire time to show for a cron that is otherwise armed.
            el('span', {
              class: 'muted',
              text: !cron.isActive ? 'deactivated' : pause.paused ? 'paused' : 'not scheduled',
            }),
      ]),
      el('td', {}, [
        el('div', { class: 'row-actions' }, [
          runControl(cron, { small: true, pause }),
          el('a', { class: 'btn small', href: `#/edit/${cron.id}`, text: 'Edit' }),
          el('a', { class: 'btn small', href: `#/logs/${cron.id}`, text: 'View logs' }),
        ]),
      ]),
    ]);
  });

  view.replaceChildren(
    head,
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

async function renderForm(id) {
  const cron = id ? await api(`/api/crons/${id}`) : null;
  const errorBox = el('div', { class: 'error', hidden: 'hidden' });

  const inputs = {
    name: el('input', { type: 'text', value: cron?.name ?? '', placeholder: 'Nightly changelog', maxlength: '120' }),
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
        el('h1', { text: id ? 'Edit cron' : 'New cron' }),
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
      field('Prompt', inputs.prompt),
      el('label', { class: 'check' }, [inputs.isActive, 'Is Active']),
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn primary', type: 'submit', text: 'Save' }),
        el('a', { class: 'btn', href: '#/', text: 'Cancel' }),
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
  const settings = await api('/api/settings');

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
    ]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'Last check' }),
      readOnly('Last checked', settings.lastUpdateCheckAt ? `${fmtDateTime(settings.lastUpdateCheckAt)} (${fmtRelative(settings.lastUpdateCheckAt)})` : 'never'),
      readOnly(
        'Last update started',
        settings.lastUpdateLaunchedAt
          ? `${fmtDateTime(settings.lastUpdateLaunchedAt)}${settings.lastUpdateFromCommit ? `, from ${settings.lastUpdateFromCommit}` : ''}`
          : 'never',
      ),
      readOnly('Project folder', settings.projectDir),
      readOnly('Update log', settings.updateLog),
    ]),
  );

  check();
}

// ---- logs -------------------------------------------------------------

const logsState = { cronId: null, selected: null, atBottom: true };

async function renderLogs(id) {
  const [{ cron, logs }, pause] = await Promise.all([api(`/api/crons/${id}/logs`), api('/api/pause')]);
  logsState.cronId = id;

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
                renderLogs(id);
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

  const panel = el('div', { class: 'log-panel' }, [
    el('div', { class: 'log-head' }, [
      el('span', { class: 'mono', text: selectedLog ? (fmtDateTime(selectedLog.startedAt) ?? selectedLog.file) : '—' }),
      liveBadge,
      el('div', { class: 'spacer' }),
      selectedLog
        ? el('a', {
            class: 'btn small',
            href: `/api/crons/${id}/logs/${encodeURIComponent(selectedLog.file)}`,
            target: '_blank',
            text: 'Raw',
          })
        : null,
    ]),
    body,
  ]);

  view.replaceChildren(
    el('div', { class: 'breadcrumb' }, [el('a', { href: '#/', text: '← All crons' })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: `Logs · ${cron.name}` }),
        el('p', {
          class: 'sub',
          text: `${logs.length} run${logs.length === 1 ? '' : 's'} kept, newest first. Oldest are pruned past 50.`,
        }),
      ]),
      el('div', { class: 'row-actions' }, [
        el('a', { class: 'btn', href: `#/edit/${cron.id}`, text: 'Edit cron' }),
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

  if (logsState.selected) openLogStream(id, logsState.selected, body, liveBadge);
}

/** Streams one log file into the pre element, appending chunks as they arrive. */
function openLogStream(cronId, file, body, liveBadge) {
  closeLogStream();
  body.textContent = '';
  liveBadge.textContent = 'streaming';
  liveBadge.className = 'pill running';

  const stream = new EventSource(`/api/crons/${cronId}/logs/${encodeURIComponent(file)}/stream`);
  logStream = stream;

  stream.addEventListener('chunk', (event) => {
    body.append(JSON.parse(event.data).text);
    if (logsState.atBottom) body.scrollTop = body.scrollHeight;
  });

  stream.addEventListener('done', () => {
    liveBadge.textContent = 'finished';
    liveBadge.className = 'pill';
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

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  closeLogStream();
  clearTimeout(modelPollTimer);
  clearTimeout(reloadTimer);
  clearTimeout(updateWatchTimer);
  const [, section, id] = hash.split('/');
  try {
    if (section === 'settings') await renderSettings();
    else if (section === 'new') await renderForm(null);
    else if (section === 'edit' && id) await renderForm(id);
    else if (section === 'logs' && id) await renderLogs(id);
    else await renderHome();
  } catch (err) {
    view.replaceChildren(
      el('div', { class: 'breadcrumb' }, [el('a', { href: '#/', text: '← All crons' })]),
      el('div', { class: 'error', text: err.message }),
    );
  }
}

/** Re-renders the current view when the server reports activity. */
function refreshCurrentView() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, section, id] = hash.split('/');
  if (section === 'logs' && id) {
    // Keep the open stream; only the run list and header need refreshing.
    renderLogs(id).catch(() => {});
  } else if (!section || section === '') {
    renderHome().catch(() => {});
  }
}

function connectEvents() {
  const events = new EventSource('/api/events');

  events.addEventListener('hello', () => {
    setConnState();
    checkHealth();
  });

  for (const type of ['crons:changed', 'run:started', 'run:finished', 'run:skipped', 'run:stopping']) {
    events.addEventListener(type, (event) => {
      const payload = JSON.parse(event.data);
      if (type === 'run:finished') toast(`"${payload.cronName}" ${payload.status} in ${payload.seconds}s`);
      if (type === 'run:skipped') {
        toast(payload.reason ? `"${payload.cronName}" skipped: ${payload.reason}` : `"${payload.cronName}" was still running; trigger skipped`, true);
      }
      refreshCurrentView();
    });
  }

  // Pause and update progress: the badges and the sub line both come from it.
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
  events.addEventListener('crons:files-changed', (event) => {
    const { added = [], updated = [], removed = [], broken = [], repaired = [] } = JSON.parse(event.data);
    for (const name of added) toast(`Cron file added: "${name}" — now scheduled`);
    for (const name of updated) toast(`Cron file updated: "${name}" — rescheduled`);
    for (const name of removed) toast(`Cron file deleted: "${name}" — unscheduled`, true);
    for (const item of broken) toast(`${item.file} is not valid JSON — still running its last saved version`, true);
    for (const name of repaired) toast(`Cron file fixed: "${name}" — rescheduled`);
    refreshCurrentView();
  });

  events.onerror = () => {
    connEl.textContent = 'reconnecting';
    connEl.className = 'conn down';
  };
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
    if (!health.commit) return; // not a git checkout, nothing to compare
    if (!loadedCommit) loadedCommit = health.commit;
    else if (health.commit !== loadedCommit) staleBuild = true;
    setConnState();
  } catch {
    /* the SSE error handler already reports a lost connection */
  }
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    storageEl.textContent = config.storageRoot;
    storageEl.title = `Crons: ${config.cronsDir}\nLogs: ${config.logsDir}`;
  } catch {
    /* not fatal */
  }
}

window.addEventListener('hashchange', route);
// Cheap, and a restart is exactly when the running commit changes.
setInterval(checkHealth, 20000);
// Keeps "3m ago" / "in 20m" honest without hammering the API.
setInterval(() => {
  const [, section] = (location.hash.replace(/^#/, '') || '/').split('/');
  if (!section) renderHome().catch(() => {});
}, 15000);

loadConfig();
checkHealth();
connectEvents();
route();
