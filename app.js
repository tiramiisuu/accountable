/**
 * Accountable - Resilience & Momentum Tracker
 * Pure client-side, local-first addiction accountability web application.
 */

(function () {
  'use strict';

  // --- Constants & Storage Keys ---
  const STORAGE_KEY_ENTRIES = 'accountable_entries_v1';
  const STORAGE_KEY_SETTINGS = 'accountable_settings_v1';
  const STORAGE_KEY_MERGED_STARE_BENE = 'accountable_merged_stare_bene_v1';
  const STORAGE_KEY_SYNC_CONFIG = 'accountable_sync_config_v1';
  const STORAGE_KEY_DELETED = 'accountable_deleted_v1';

  const DEFAULT_SETTINGS = {
    alphaUp: 0.16,      // recovery climb rate per clean day
    alphaDown: 0.20,    // dip penalty rate per relapse
    minorValue: 50,     // close call / minor slip % target
    baselineStart: 60   // initial starting momentum
  };

  // Status definitions
  const STATUS_CONFIG = {
    clean: {
      label: 'Clean',
      value: 100,
      className: 'cell-clean',
      pillClass: 'status-pill-clean',
      color: '#10b981',
      bgAlpha: 'rgba(16, 185, 129, 0.2)'
    },
    minor: {
      label: 'Close Call',
      value: 50,
      className: 'cell-minor',
      pillClass: 'status-pill-minor',
      color: '#f59e0b',
      bgAlpha: 'rgba(245, 158, 11, 0.2)'
    },
    relapse: {
      label: 'Relapse',
      value: 0,
      className: 'cell-relapse',
      pillClass: 'status-pill-relapse',
      color: '#f43f5e',
      bgAlpha: 'rgba(244, 63, 94, 0.2)'
    }
  };

  // --- State ---
  let state = {
    entries: {},          // { 'YYYY-MM-DD': { status: 'clean'|'minor'|'relapse', notes: '' } }
    momentumMap: {},      // { 'YYYY-MM-DD': number (0-100) }
    settings: { ...DEFAULT_SETTINGS },
    heatmapMode: 'rolling', // 'rolling' (past 52 weeks) or a specific year e.g. 2026
    heatmapYear: new Date().getFullYear(),
    chartRange: 'all',    // '30', '90', '365', 'all'
    tableSearch: '',
    tablePage: 1,
    tablePageSize: 10,
    editingDate: null,
    editingStatus: null,
    deleted: {},
    sync: {
      token: '',
      gistId: '',
      lastSync: null,
      isSyncing: false,
      status: 'offline'
    }
  };

  let chartInstance = null;

  // --- Date Helpers (Timezone-safe) ---
  function parseDateStr(str) {
    if (!str) return new Date();
    const parts = str.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function formatDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function getTodayStr() {
    return formatDateStr(new Date());
  }

  function addDays(date, days) {
    const res = new Date(date.getTime());
    res.setDate(res.getDate() + days);
    return res;
  }

  function formatDisplayDate(dateStr, withWeekday = true) {
    if (!dateStr) return '';
    const date = parseDateStr(dateStr);
    const options = {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    };
    if (withWeekday) {
      options.weekday = 'short';
    }
    return date.toLocaleDateString(undefined, options);
  }

  // --- Persistence ---
  function loadData() {
    try {
      const rawEntries = localStorage.getItem(STORAGE_KEY_ENTRIES);
      let parsed = {};
      if (rawEntries) {
        try {
          parsed = JSON.parse(rawEntries) || {};
        } catch (e) {
          parsed = {};
        }
      }

      const hasMergedStareBene = localStorage.getItem(STORAGE_KEY_MERGED_STARE_BENE) === 'true';

      if (!hasMergedStareBene && typeof PRELOADED_ENTRIES !== 'undefined' && Object.keys(PRELOADED_ENTRIES).length > 0) {
        // Merge imported entries with existing user entries (user's manual entries take precedence)
        state.entries = { ...PRELOADED_ENTRIES, ...parsed };
        localStorage.setItem(STORAGE_KEY_MERGED_STARE_BENE, 'true');
        saveData();
      } else {
        state.entries = parsed;
      }

      const rawDeleted = localStorage.getItem(STORAGE_KEY_DELETED);
      if (rawDeleted) {
        try {
          state.deleted = JSON.parse(rawDeleted) || {};
        } catch (e) {
          state.deleted = {};
        }
      }

      // Purge accidental tomorrow entry if present
      if (state.entries['2026-10-22']) {
        delete state.entries['2026-10-22'];
        state.deleted['2026-10-22'] = Date.now();
      }

      const rawSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
      if (rawSettings) {
        state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(rawSettings) };
      }
    } catch (e) {
      console.error('Failed to load data from localStorage', e);
      showToast('Error loading saved data from browser storage', 'error');
    }
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY_ENTRIES, JSON.stringify(state.entries));
      localStorage.setItem(STORAGE_KEY_DELETED, JSON.stringify(state.deleted));
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(state.settings));
      scheduleAutoSync();
    } catch (e) {
      console.error('Failed to save data to localStorage', e);
      showToast('Error saving data to browser storage', 'error');
    }
  }

  // --- Momentum & Analytics Calculations ---
  function recalculateMomentum() {
    state.momentumMap = {};
    const sortedDates = Object.keys(state.entries).sort();
    if (sortedDates.length === 0) return;

    let currentScore = state.settings.baselineStart;

    sortedDates.forEach((dateStr, idx) => {
      const entry = state.entries[dateStr];
      const targetVal = entry.status === 'clean' ? 100
                      : entry.status === 'minor' ? state.settings.minorValue
                      : 0; // relapse

      if (idx === 0) {
        // First entry baseline transition
        if (entry.status === 'clean') currentScore = Math.max(65, state.settings.baselineStart);
        else if (entry.status === 'minor') currentScore = state.settings.minorValue;
        else currentScore = 30;
      } else {
        if (targetVal >= currentScore) {
          // Climbing back / maintaining
          currentScore = currentScore + (targetVal - currentScore) * state.settings.alphaUp;
        } else {
          // Relapse / slip dip
          currentScore = currentScore + (targetVal - currentScore) * state.settings.alphaDown;
        }
      }

      currentScore = Math.max(0, Math.min(100, currentScore));
      state.momentumMap[dateStr] = Math.round(currentScore * 10) / 10;
    });
  }

  function getStats() {
    const dates = Object.keys(state.entries).sort();
    const totalDays = dates.length;

    if (totalDays === 0) {
      return {
        currentMomentum: 0,
        peakMomentum: 0,
        peakDate: null,
        cleanCount: 0,
        minorCount: 0,
        relapseCount: 0,
        cleanRate: 0,
        totalDays: 0,
        statusLabel: 'No data'
      };
    }

    let cleanCount = 0;
    let minorCount = 0;
    let relapseCount = 0;
    let peakMomentum = 0;
    let peakDate = null;

    dates.forEach(d => {
      const status = state.entries[d].status;
      if (status === 'clean') cleanCount++;
      else if (status === 'minor') minorCount++;
      else if (status === 'relapse') relapseCount++;

      const score = state.momentumMap[d] || 0;
      if (score >= peakMomentum) {
        peakMomentum = score;
        peakDate = d;
      }
    });

    const latestDate = dates[dates.length - 1];
    const currentMomentum = state.momentumMap[latestDate] || 0;
    const cleanRate = Math.round((cleanCount / totalDays) * 100);

    let statusLabel = 'Recovering';
    if (currentMomentum >= 80) statusLabel = 'High Resilience';
    else if (currentMomentum >= 55) statusLabel = 'Steady Growth';
    else if (currentMomentum >= 35) statusLabel = 'Rebuilding';
    else statusLabel = 'Caution';

    return {
      currentMomentum,
      peakMomentum,
      peakDate,
      cleanCount,
      minorCount,
      relapseCount,
      cleanRate,
      totalDays,
      statusLabel,
      latestDate
    };
  }

  function getStreaks() {
    const today = getTodayStr();
    const sortedDates = Object.keys(state.entries).sort();

    if (sortedDates.length === 0) {
      return { current: 0, best: 0 };
    }

    let bestStreak = 0;
    let currentRun = 0;
    let prevDate = null;

    for (const dStr of sortedDates) {
      const isClean = state.entries[dStr].status === 'clean';

      if (prevDate !== null) {
        const prev = parseDateStr(prevDate);
        const cur = parseDateStr(dStr);
        const isConsecutive = (cur - prev) / 86400000 === 1;
        if (isClean && isConsecutive) {
          currentRun++;
        } else if (isClean) {
          currentRun = 1;
        } else {
          currentRun = 0;
        }
      } else {
        currentRun = isClean ? 1 : 0;
      }

      if (currentRun > bestStreak) bestStreak = currentRun;
      prevDate = dStr;
    }

    // If the last logged date is not today or yesterday, current streak is broken
    const lastDate = sortedDates[sortedDates.length - 1];
    const todayDate = parseDateStr(today);
    const lastLogDate = parseDateStr(lastDate);
    const dayGap = (todayDate - lastLogDate) / 86400000;
    const activeStreak = dayGap <= 1 ? currentRun : 0;

    return { current: activeStreak, best: bestStreak };
  }

  // --- UI Update: KPI Cards ---
  function renderKPIs() {
    const stats = getStats();

    const currentElem = document.getElementById('kpi-current-momentum');
    const badgeElem = document.getElementById('kpi-momentum-badge');
    const barElem = document.getElementById('kpi-momentum-bar');
    const subtextElem = document.getElementById('kpi-current-subtext');

    currentElem.textContent = `${stats.currentMomentum}%`;
    badgeElem.textContent = stats.statusLabel;
    barElem.style.width = `${stats.currentMomentum}%`;

    badgeElem.className = 'badge ' + (
      stats.currentMomentum >= 80 ? 'badge-resilient' :
      stats.currentMomentum >= 50 ? 'badge-recovering' : 'badge-warning'
    );

    if (stats.latestDate) {
      subtextElem.textContent = `As of ${formatDisplayDate(stats.latestDate, false)}`;
    } else {
      subtextElem.textContent = 'No logs recorded yet';
    }

    document.getElementById('kpi-peak-momentum').textContent = `${stats.peakMomentum}%`;
    document.getElementById('kpi-peak-date').textContent = stats.peakDate
      ? `Achieved on ${formatDisplayDate(stats.peakDate, false)}`
      : 'Best resilience achieved';

    document.getElementById('kpi-clean-rate').textContent = `${stats.cleanRate}%`;
    document.getElementById('kpi-clean-ratio').textContent = `${stats.cleanCount} of ${stats.totalDays} days clean`;

    document.getElementById('kpi-count-clean').textContent = stats.cleanCount;
    document.getElementById('kpi-count-minor').textContent = stats.minorCount;
    document.getElementById('kpi-count-relapse').textContent = stats.relapseCount;
    document.getElementById('kpi-total-logged').textContent = `${stats.totalDays} total days logged`;
  }

  // --- UI Update: Heatmap (Contribution Graph) ---
  function renderHeatmap() {
    const gridElem = document.getElementById('heatmap-grid');
    const monthsElem = document.getElementById('heatmap-months');
    const yearLabelElem = document.getElementById('heatmap-year-label');
    const rollingBtn = document.getElementById('btn-heatmap-rolling');

    gridElem.innerHTML = '';
    monthsElem.innerHTML = '';

    let startDate, endDate;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = getTodayStr();

    if (state.heatmapMode === 'rolling') {
      yearLabelElem.textContent = '52 Weeks';
      rollingBtn.classList.add('active');

      // End at the upcoming Sunday to complete the final column
      endDate = new Date(today.getTime());
      const dayOfWeek = (endDate.getDay() + 6) % 7; // Mon=0, Sun=6
      endDate.setDate(endDate.getDate() + (6 - dayOfWeek));

      // Start 52 weeks back on Monday
      startDate = new Date(endDate.getTime());
      startDate.setDate(startDate.getDate() - (52 * 7) + 1);
    } else {
      yearLabelElem.textContent = state.heatmapYear;
      rollingBtn.classList.remove('active');

      const yearStart = new Date(state.heatmapYear, 0, 1);
      const startDayOfWeek = (yearStart.getDay() + 6) % 7;
      startDate = new Date(yearStart.getTime());
      startDate.setDate(startDate.getDate() - startDayOfWeek);

      const yearEnd = new Date(state.heatmapYear, 11, 31);
      const endDayOfWeek = (yearEnd.getDay() + 6) % 7;
      endDate = new Date(yearEnd.getTime());
      endDate.setDate(endDate.getDate() + (6 - endDayOfWeek));
    }

    // Generate days
    const days = [];
    let cur = new Date(startDate.getTime());
    while (cur <= endDate) {
      days.push(new Date(cur.getTime()));
      cur.setDate(cur.getDate() + 1);
    }

    // Month header labels
    const totalWeeks = Math.ceil(days.length / 7);
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let lastMonth = -1;

    for (let w = 0; w < totalWeeks; w++) {
      const firstDayOfWeek = days[w * 7];
      if (!firstDayOfWeek) break;
      const m = firstDayOfWeek.getMonth();
      const colDiv = document.createElement('div');
      colDiv.style.gridColumn = `${w + 1}`;
      if (m !== lastMonth && firstDayOfWeek.getDate() <= 14) {
        colDiv.textContent = monthNames[m];
        lastMonth = m;
      }
      monthsElem.appendChild(colDiv);
    }

    // Render cells in grid
    const fragment = document.createDocumentFragment();
    days.forEach(d => {
      const dStr = formatDateStr(d);
      const entry = state.entries[dStr];
      const momentum = state.momentumMap[dStr];

      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      cell.dataset.date = dStr;

      if (entry) {
        const cfg = STATUS_CONFIG[entry.status];
        if (cfg) cell.classList.add(cfg.className);
      }

      if (dStr === todayStr) {
        cell.classList.add('cell-today');
      }

      // Tooltip title
      let titleText = `${formatDisplayDate(dStr, true)}: `;
      if (entry) {
        titleText += `${STATUS_CONFIG[entry.status]?.label || entry.status}`;
        if (momentum !== undefined) titleText += ` (${momentum}%)`;
        if (entry.notes) titleText += ` - "${entry.notes}"`;
      } else {
        titleText += 'No entry';
      }
      cell.title = titleText;

      cell.addEventListener('click', () => openDayEditModal(dStr));
      fragment.appendChild(cell);
    });

    gridElem.appendChild(fragment);

    // Scroll heatmap container to the right end (today) on load
    const container = document.getElementById('heatmap-container');
    container.scrollLeft = container.scrollWidth;
  }

  // --- UI Update: Willpower Meter ---
  function renderWillpower() {
    const { current, best } = getStreaks();

    const currentEl = document.getElementById('streak-current');
    const bestEl = document.getElementById('streak-best');
    const fireIcon = document.getElementById('fire-icon');
    const fireLabel = document.getElementById('willpower-status-label');

    if (!currentEl) return;

    currentEl.textContent = current;
    bestEl.textContent = best;

    // Dynamic fire emoji and label based on streak length
    let emoji = '🌱';
    let label = 'Plant the seed';
    if (current >= 1 && current < 7) {
      emoji = '🔥';
      label = 'Getting warm!';
    } else if (current >= 7 && current < 14) {
      emoji = '🔥🔥';
      label = 'One week strong!';
    } else if (current >= 14 && current < 30) {
      emoji = '⚡';
      label = 'Two-week warrior!';
    } else if (current >= 30 && current < 60) {
      emoji = '🏆';
      label = '30-day legend!';
    } else if (current >= 60 && current < 100) {
      emoji = '💎';
      label = 'Diamond mindset!';
    } else if (current >= 100) {
      emoji = '👑';
      label = 'Absolute ruler!';
    } else if (current === 0) {
      emoji = '🌱';
      label = 'Log a clean day!';
    }

    fireIcon.textContent = emoji;
    fireLabel.textContent = label;

    // Pulse animation on the current number
    currentEl.style.transform = 'scale(1.1)';
    currentEl.style.transition = 'transform 0s';
    setTimeout(() => {
      currentEl.style.transform = 'scale(1)';
      currentEl.style.transition = 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
    }, 50);
  }

  // --- UI Update: Chart.js Line Chart ---
  function renderChart() {
    const canvas = document.getElementById('momentumChart');
    if (!canvas) return;

    const sortedDates = Object.keys(state.entries).sort();

    // Filter by range if needed
    let filteredDates = sortedDates;
    if (state.chartRange !== 'all') {
      const daysCount = parseInt(state.chartRange, 10);
      const cutoff = addDays(new Date(), -daysCount);
      const cutoffStr = formatDateStr(cutoff);
      filteredDates = sortedDates.filter(d => d >= cutoffStr);
    }

    const labels = filteredDates.map(d => formatDisplayDate(d, false));
    const dataValues = filteredDates.map(d => state.momentumMap[d] ?? 0);

    const pointBgColors = filteredDates.map(d => {
      const status = state.entries[d]?.status;
      return STATUS_CONFIG[status]?.color || '#3b82f6';
    });

    const pointRadii = filteredDates.map(d => {
      const status = state.entries[d]?.status;
      return status === 'relapse' ? 6 : (status === 'minor' ? 5 : 4);
    });

    if (chartInstance) {
      chartInstance.destroy();
    }

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
    gradient.addColorStop(0.5, 'rgba(16, 185, 129, 0.08)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Resilience Momentum (%)',
            data: dataValues,
            fill: true,
            backgroundColor: gradient,
            borderColor: '#10b981',
            borderWidth: 2.5,
            tension: 0.25,
            pointBackgroundColor: pointBgColors,
            pointBorderColor: '#0f172a',
            pointBorderWidth: 1.5,
            pointRadius: pointRadii,
            pointHoverRadius: 8
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: '#0f172a',
            titleColor: '#f8fafc',
            bodyColor: '#cbd5e1',
            borderColor: 'rgba(255, 255, 255, 0.15)',
            borderWidth: 1,
            padding: 12,
            boxPadding: 6,
            callbacks: {
              title: function (items) {
                const idx = items[0].dataIndex;
                const dateStr = filteredDates[idx];
                return formatDisplayDate(dateStr, true);
              },
              label: function (context) {
                const idx = context.dataIndex;
                const dateStr = filteredDates[idx];
                const entry = state.entries[dateStr];
                const statusName = STATUS_CONFIG[entry?.status]?.label || 'Logged';
                return `Momentum: ${context.parsed.y}% (${statusName})`;
              },
              afterLabel: function (context) {
                const idx = context.dataIndex;
                const dateStr = filteredDates[idx];
                const notes = state.entries[dateStr]?.notes;
                return notes ? `Notes: "${notes}"` : '';
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(255, 255, 255, 0.04)'
            },
            ticks: {
              color: '#64748b',
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 12,
              font: { size: 11 }
            }
          },
          y: {
            min: 0,
            max: 100,
            grid: {
              color: function (context) {
                if (context.tick.value === 80) return 'rgba(148, 163, 184, 0.25)';
                return 'rgba(255, 255, 255, 0.04)';
              }
            },
            ticks: {
              color: '#64748b',
              stepSize: 20,
              callback: function (val) {
                return val + '%';
              },
              font: { size: 11 }
            }
          }
        }
      }
    });
  }

  // --- UI Update: Recent Entries Table ---
  function renderTable() {
    const tbody = document.getElementById('logs-table-body');
    const paginationElem = document.getElementById('table-page-info');

    const sortedDates = Object.keys(state.entries).sort().reverse();
    const query = state.tableSearch.trim().toLowerCase();

    const filtered = sortedDates.filter(d => {
      if (!query) return true;
      const entry = state.entries[d];
      return d.includes(query) || (entry.notes && entry.notes.toLowerCase().includes(query));
    });

    const total = filtered.length;
    const pageSize = state.tablePageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    if (state.tablePage > totalPages) state.tablePage = totalPages;
    if (state.tablePage < 1) state.tablePage = 1;

    const startIdx = (state.tablePage - 1) * pageSize;
    const pageItems = filtered.slice(startIdx, startIdx + pageSize);

    if (pageItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No matching entries found.</td></tr>`;
      paginationElem.textContent = '0 entries';
      return;
    }

    paginationElem.textContent = `Showing ${startIdx + 1} - ${startIdx + pageItems.length} of ${total} entries`;

    tbody.innerHTML = pageItems.map(d => {
      const entry = state.entries[d];
      const cfg = STATUS_CONFIG[entry.status] || STATUS_CONFIG.clean;
      const momentum = state.momentumMap[d] ?? '--';

      return `
        <tr>
          <td><strong>${formatDisplayDate(d, true)}</strong></td>
          <td><span class="status-pill ${cfg.pillClass}">${cfg.label}</span></td>
          <td>${cfg.value}%</td>
          <td><strong>${momentum}%</strong></td>
          <td style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${entry.notes || ''}">
            ${entry.notes ? entry.notes : '<span class="text-muted">&mdash;</span>'}
          </td>
          <td class="text-right">
            <button class="btn btn-sm btn-secondary" onclick="window.accountableApp.openDayEditModal('${d}')">Edit</button>
            <button class="btn btn-sm btn-outline-danger" onclick="window.accountableApp.deleteEntry('${d}')">Delete</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // --- Modal: Day Edit ---
  function openDayEditModal(dateStr) {
    state.editingDate = dateStr || getTodayStr();
    const entry = state.entries[state.editingDate];
    const subElem = document.getElementById('modal-day-subtitle');
    const deleteBtn = document.getElementById('modal-btn-delete');

    document.getElementById('modal-input-date').value = state.editingDate;
    document.getElementById('modal-day-title').textContent = `Log Entry &bull; ${formatDisplayDate(state.editingDate, true)}`;
    document.getElementById('modal-input-notes').value = entry ? (entry.notes || '') : '';

    if (entry) {
      const cfg = STATUS_CONFIG[entry.status];
      subElem.textContent = `Current status: ${cfg?.label || entry.status} (${cfg?.value || 0}%)`;
      selectStatusButton(entry.status);
      deleteBtn.style.display = 'inline-flex';
    } else {
      subElem.textContent = 'No entry logged for this day yet. Select a status:';
      selectStatusButton(null); // Do not pre-select any status on an unlogged day!
      deleteBtn.style.display = 'none';
    }

    // Update momentum preview
    updateModalMomentumPreview();

    const modal = document.getElementById('modal-day-edit');
    modal.classList.remove('hidden');
  }

  function closeDayEditModal() {
    const modal = document.getElementById('modal-day-edit');
    modal.classList.add('hidden');
    state.editingDate = null;
    state.editingStatus = null;
  }

  function selectStatusButton(status) {
    state.editingStatus = status;
    const buttons = document.querySelectorAll('.status-btn');
    buttons.forEach(btn => {
      if (btn.dataset.status === status) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    updateModalMomentumPreview();
  }

  function updateModalMomentumPreview() {
    const previewElem = document.getElementById('modal-preview-momentum');
    if (!state.editingDate || !state.editingStatus) {
      previewElem.textContent = '--';
      return;
    }
    const currentMomentum = state.momentumMap[state.editingDate];
    previewElem.textContent = currentMomentum !== undefined ? `${currentMomentum}%` : 'Calculates on save';
  }

  function saveCurrentEntry(advanceDays = 0) {
    if (!state.editingDate) return;
    if (!state.editingStatus) {
      alert('Please select a status (Clean, Close Call, or Relapse) before saving.');
      return;
    }

    const notes = document.getElementById('modal-input-notes').value.trim();
    state.entries[state.editingDate] = {
      status: state.editingStatus,
      notes: notes,
      updatedAt: Date.now()
    };
    if (state.deleted[state.editingDate]) {
      delete state.deleted[state.editingDate];
    }

    saveData();
    recalculateMomentum();
    renderAll();

    showToast(`Saved entry for ${state.editingDate}`, 'success');

    if (advanceDays !== 0) {
      const curDate = parseDateStr(state.editingDate);
      const nextDate = addDays(curDate, advanceDays);
      openDayEditModal(formatDateStr(nextDate));
    } else {
      closeDayEditModal();
    }
  }

  function deleteEntry(dateStr) {
    if (!state.entries[dateStr]) {
      closeDayEditModal();
      return;
    }
    if (confirm(`Clear entry for ${formatDisplayDate(dateStr, true)}?`)) {
      delete state.entries[dateStr];
      state.deleted[dateStr] = Date.now();
      saveData();
      recalculateMomentum();
      renderAll();
      showToast(`Removed entry for ${dateStr}`, 'success');
      closeDayEditModal();
      syncWithCloud(true);
    }
  }

  // --- Modal: Batch Fill ---
  function openBatchModal() {
    const today = getTodayStr();
    document.getElementById('batch-end-date').value = today;
    // Default start to 30 days ago
    document.getElementById('batch-start-date').value = formatDateStr(addDays(parseDateStr(today), -30));
    document.getElementById('batch-notes').value = '';

    // Set batch status to clean default
    selectBatchStatusButton('clean');

    document.getElementById('modal-batch-fill').classList.remove('hidden');
  }

  function closeBatchModal() {
    document.getElementById('modal-batch-fill').classList.add('hidden');
  }

  let selectedBatchStatus = 'clean';
  function selectBatchStatusButton(status) {
    selectedBatchStatus = status;
    document.querySelectorAll('.btn-batch-status').forEach(btn => {
      if (btn.dataset.batchStatus === status) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  function applyBatchFill() {
    const startStr = document.getElementById('batch-start-date').value;
    const endStr = document.getElementById('batch-end-date').value;
    const notes = document.getElementById('batch-notes').value.trim();

    if (!startStr || !endStr) {
      alert('Please select both start and end dates.');
      return;
    }

    if (startStr > endStr) {
      alert('Start date must be before or equal to End date.');
      return;
    }

    let cur = parseDateStr(startStr);
    const end = parseDateStr(endStr);
    let count = 0;

    while (cur <= end) {
      const dStr = formatDateStr(cur);
      if (selectedBatchStatus === 'clear') {
        delete state.entries[dStr];
      } else {
        state.entries[dStr] = {
          status: selectedBatchStatus,
          notes: notes,
          updatedAt: Date.now()
        };
      }
      count++;
      cur.setDate(cur.getDate() + 1);
    }

    saveData();
    recalculateMomentum();
    renderAll();
    closeBatchModal();

    showToast(`Successfully updated ${count} days in batch!`, 'success');
  }

  // --- Modal: Settings ---
  function openSettingsModal() {
    document.getElementById('setting-alpha-up').value = state.settings.alphaUp;
    document.getElementById('setting-alpha-up-val').textContent = `${Math.round(state.settings.alphaUp * 100)}%`;

    document.getElementById('setting-alpha-down').value = state.settings.alphaDown;
    document.getElementById('setting-alpha-down-val').textContent = `${Math.round(state.settings.alphaDown * 100)}%`;

    document.getElementById('setting-minor-val').value = state.settings.minorValue;
    document.getElementById('setting-minor-val-val').textContent = `${state.settings.minorValue}%`;

    document.getElementById('modal-settings').classList.remove('hidden');
  }

  function closeSettingsModal() {
    document.getElementById('modal-settings').classList.add('hidden');
  }

  function saveSettings() {
    state.settings.alphaUp = parseFloat(document.getElementById('setting-alpha-up').value);
    state.settings.alphaDown = parseFloat(document.getElementById('setting-alpha-down').value);
    state.settings.minorValue = parseInt(document.getElementById('setting-minor-val').value, 10);

    saveData();
    recalculateMomentum();
    renderAll();
    closeSettingsModal();
    showToast('Momentum scoring settings updated!', 'success');
  }

  // --- Excel Export (with Embedded High-Res Chart) ---
  async function exportToExcel() {
    if (typeof ExcelJS === 'undefined') {
      alert('ExcelJS engine not loaded. Please ensure vendor/exceljs.min.js is present.');
      return;
    }

    showToast('Generating Excel report with chart...', 'success');

    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Accountable Resilience Tracker';
      workbook.created = new Date();

      const stats = getStats();
      const todayStr = getTodayStr();

      // --- SHEET 1: Dashboard & Chart ---
      const dashSheet = workbook.addWorksheet('Dashboard & Overview', {
        views: [{ showGridLines: true }]
      });

      // Title Banner
      dashSheet.mergeCells('B2:H2');
      const titleCell = dashSheet.getCell('B2');
      titleCell.value = 'ACCOUNTABILITY & RESILIENCE REPORT';
      titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
      titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
      dashSheet.getRow(2).height = 36;

      dashSheet.mergeCells('B3:H3');
      const subCell = dashSheet.getCell('B3');
      subCell.value = `Exported on ${formatDisplayDate(todayStr, true)} | Habit Recovery & Momentum`;
      subCell.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF94A3B8' } };
      subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
      subCell.alignment = { vertical: 'middle', horizontal: 'center' };
      dashSheet.getRow(3).height = 20;

      // KPI Metric Cards
      const kpis = [
        ['Current Momentum', `${stats.currentMomentum}%`, 'FF10B981'],
        ['Peak Momentum', `${stats.peakMomentum}%`, 'FF3B82F6'],
        ['Total Tracked Days', stats.totalDays, 'FF64748B'],
        ['Clean Days Rate', `${stats.cleanRate}%`, 'FF10B981'],
        ['Clean Days Count', stats.cleanCount, 'FF059669'],
        ['Close Calls / Minor', stats.minorCount, 'FFF59E0B'],
        ['Relapses (Dips)', stats.relapseCount, 'FFF43F5E']
      ];

      kpis.forEach((kpi, idx) => {
        const row = 5 + idx;
        const labelCell = dashSheet.getCell(`B${row}`);
        labelCell.value = kpi[0];
        labelCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF334155' } };
        labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        labelCell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };

        const valCell = dashSheet.getCell(`C${row}`);
        valCell.value = kpi[1];
        valCell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: kpi[2] } };
        valCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        valCell.alignment = { horizontal: 'right' };
        valCell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
        dashSheet.getRow(row).height = 24;
      });

      // Embed High-Res Chart Image if chart exists
      if (chartInstance) {
        const chartBase64 = chartInstance.toBase64Image('image/png', 1);
        const imageId = workbook.addImage({
          base64: chartBase64,
          extension: 'png'
        });

        // Place chart on the right side of the KPIs
        dashSheet.addImage(imageId, {
          tl: { col: 3.5, row: 4 },
          ext: { width: 620, height: 280 }
        });
      }

      dashSheet.getColumn(2).width = 24;
      dashSheet.getColumn(3).width = 16;

      // --- SHEET 2: Detailed Daily Logs ---
      const logSheet = workbook.addWorksheet('Daily Logs', {
        views: [{ showGridLines: true }]
      });

      // Headers
      const headers = ['Date', 'Day of Week', 'Status', 'Adherence %', 'Resilience Momentum', 'Notes & Triggers'];
      const headerRow = logSheet.getRow(2);
      headers.forEach((h, i) => {
        const cell = headerRow.getCell(i + 2);
        cell.value = h;
        cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
        cell.alignment = { vertical: 'middle', horizontal: i === 5 ? 'left' : 'center' };
      });
      headerRow.height = 28;

      // Populate Rows
      const sortedDates = Object.keys(state.entries).sort();
      sortedDates.forEach((dStr, idx) => {
        const row = logSheet.getRow(idx + 3);
        const entry = state.entries[dStr];
        const dObj = parseDateStr(dStr);
        const weekday = dObj.toLocaleDateString(undefined, { weekday: 'long' });
        const momentum = (state.momentumMap[dStr] ?? 0) / 100;
        const cfg = STATUS_CONFIG[entry.status];

        // Date
        const cDate = row.getCell(2);
        cDate.value = dStr;
        cDate.alignment = { horizontal: 'center' };

        // Weekday
        const cDay = row.getCell(3);
        cDay.value = weekday;
        cDay.alignment = { horizontal: 'center' };

        // Status
        const cStatus = row.getCell(4);
        cStatus.value = cfg.label;
        cStatus.alignment = { horizontal: 'center' };
        cStatus.font = { bold: true };
        if (entry.status === 'clean') {
          cStatus.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } };
          cStatus.font = { color: { argb: 'FF137333' }, bold: true };
        } else if (entry.status === 'minor') {
          cStatus.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF7E0' } };
          cStatus.font = { color: { argb: 'FFB06000' }, bold: true };
        } else {
          cStatus.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
          cStatus.font = { color: { argb: 'FFC5221F' }, bold: true };
        }

        // Adherence %
        const cAdh = row.getCell(5);
        cAdh.value = cfg.value / 100;
        cAdh.numFmt = '0%';
        cAdh.alignment = { horizontal: 'right' };

        // Momentum
        const cMom = row.getCell(6);
        cMom.value = momentum;
        cMom.numFmt = '0.0%';
        cMom.alignment = { horizontal: 'right' };
        cMom.font = { bold: true };

        // Notes
        const cNotes = row.getCell(7);
        cNotes.value = entry.notes || '';

        row.height = 20;

        // Thin border
        for (let col = 2; col <= 7; col++) {
          row.getCell(col).border = {
            top: { style: 'thin', color: { argb: 'FFF1F5F9' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }
          };
        }
      });

      // Auto-fit column widths
      logSheet.getColumn(2).width = 14;
      logSheet.getColumn(3).width = 16;
      logSheet.getColumn(4).width = 16;
      logSheet.getColumn(5).width = 15;
      logSheet.getColumn(6).width = 22;
      logSheet.getColumn(7).width = 45;

      // Write buffer and trigger browser download
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Accountable_Report_${todayStr}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast('Excel report downloaded successfully!', 'success');
    } catch (err) {
      console.error('Error generating Excel export', err);
      showToast('Failed to export Excel file. See console.', 'error');
    }
  }

  // --- JSON Backup & Restore ---
  function exportJSON() {
    const dataStr = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: state.entries,
      settings: state.settings
    }, null, 2);

    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `accountable_backup_${getTodayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('JSON backup downloaded!', 'success');
  }

  function importJSON(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const parsed = JSON.parse(e.target.result);
        if (parsed.entries && typeof parsed.entries === 'object') {
          state.entries = parsed.entries;
          if (parsed.settings) state.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
          saveData();
          recalculateMomentum();
          renderAll();
          showToast(`Successfully imported data (${Object.keys(state.entries).length} days)!`, 'success');
        } else {
          showToast('Invalid backup file format.', 'error');
        }
      } catch (err) {
        console.error(err);
        showToast('Error parsing JSON backup file.', 'error');
      }
    };
    reader.readAsText(file);
  }

  function clearAllData() {
    if (confirm('Are you sure you want to delete ALL logged data? This action cannot be undone.')) {
      state.entries = {};
      saveData();
      recalculateMomentum();
      renderAll();
      showToast('All data has been cleared.', 'success');
    }
  }

  // --- Cloud Sync (GitHub Gist) ---
  let autoSyncTimeout = null;

  function loadSyncConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SYNC_CONFIG);
      if (raw) {
        const parsed = JSON.parse(raw);
        state.sync.token = parsed.token || '';
        state.sync.gistId = parsed.gistId || '';
        state.sync.lastSync = parsed.lastSync || null;
      }
    } catch (e) {
      console.error('Failed to load sync config', e);
    }
    updateSyncUI();
  }

  function saveSyncConfig() {
    try {
      localStorage.setItem(STORAGE_KEY_SYNC_CONFIG, JSON.stringify({
        token: state.sync.token,
        gistId: state.sync.gistId,
        lastSync: state.sync.lastSync
      }));
    } catch (e) {
      console.error('Failed to save sync config', e);
    }
    updateSyncUI();
  }

  function updateSyncUI() {
    const dot = document.getElementById('sync-indicator-dot');
    const text = document.getElementById('sync-status-text');
    const statusCard = document.getElementById('sync-status-card');
    const setupForm = document.getElementById('sync-setup-form');
    const statusDetails = document.getElementById('sync-status-details');

    if (!dot || !text) return;

    dot.className = 'sync-dot';
    if (state.sync.isSyncing) {
      dot.classList.add('dot-syncing');
      text.textContent = 'Syncing...';
    } else if (state.sync.token && state.sync.gistId) {
      dot.classList.add('dot-synced');
      text.textContent = 'Synced';
      if (statusCard) statusCard.classList.remove('hidden');
      if (setupForm) setupForm.classList.add('hidden');
      if (statusDetails) {
        const lastTime = state.sync.lastSync
          ? new Date(state.sync.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : 'Never';
        statusDetails.textContent = `Gist: ${state.sync.gistId.slice(0, 8)}... | Last sync: ${lastTime}`;
      }
    } else {
      dot.classList.add('dot-offline');
      text.textContent = 'Cloud Sync';
      if (statusCard) statusCard.classList.add('hidden');
      if (setupForm) setupForm.classList.remove('hidden');
    }
  }

  function openCloudSyncModal() {
    document.getElementById('input-github-token').value = state.sync.token || '';
    document.getElementById('input-gist-id').value = state.sync.gistId || '';
    document.getElementById('pairing-link-box').classList.add('hidden');
    updateSyncUI();
    document.getElementById('modal-cloud-sync').classList.remove('hidden');
  }

  function closeCloudSyncModal() {
    document.getElementById('modal-cloud-sync').classList.add('hidden');
  }

  async function syncWithCloud(isAuto = false) {
    if (!state.sync.token || !state.sync.gistId) return;
    if (state.sync.isSyncing) return;

    state.sync.isSyncing = true;
    updateSyncUI();

    try {
      // 1. Fetch remote Gist
      const res = await fetch(`https://api.github.com/gists/${state.sync.gistId}`, {
        headers: {
          'Authorization': `Bearer ${state.sync.token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!res.ok) {
        throw new Error(`GitHub API error (${res.status})`);
      }

      const gist = await res.json();
      const file = gist.files && gist.files['accountable_data.json'];
      let remotePayload = null;
      if (file && file.content) {
        try {
          remotePayload = JSON.parse(file.content);
        } catch (e) {}
      }

      // 2. Merge remote entries & deletions with local
      let hasChanges = false;
      if (remotePayload) {
        // Merge remote tombstones
        if (remotePayload.deleted && typeof remotePayload.deleted === 'object') {
          for (const [delDate, delTime] of Object.entries(remotePayload.deleted)) {
            state.deleted[delDate] = Math.max(state.deleted[delDate] || 0, delTime);
          }
        }

        // Merge entries
        if (remotePayload.entries && typeof remotePayload.entries === 'object') {
          for (const [dateStr, remoteEntry] of Object.entries(remotePayload.entries)) {
            const delTime = state.deleted[dateStr] || 0;
            const rTime = remoteEntry.updatedAt || 0;

            if (delTime >= rTime) {
              if (state.entries[dateStr]) {
                delete state.entries[dateStr];
                hasChanges = true;
              }
              continue;
            }

            const localEntry = state.entries[dateStr];
            if (!localEntry) {
              state.entries[dateStr] = remoteEntry;
              hasChanges = true;
            } else {
              const lTime = localEntry.updatedAt || 0;
              if (rTime > lTime) {
                state.entries[dateStr] = remoteEntry;
                hasChanges = true;
              }
            }
          }
        }

        // Clean local entries that were deleted
        for (const [delDate, delTime] of Object.entries(state.deleted)) {
          if (state.entries[delDate] && (state.entries[delDate].updatedAt || 0) <= delTime) {
            delete state.entries[delDate];
            hasChanges = true;
          }
        }

        if (remotePayload.settings) {
          state.settings = { ...state.settings, ...remotePayload.settings };
        }
      }

      if (hasChanges) {
        saveData();
        recalculateMomentum();
        renderAll();
      }

      // 3. Push merged state back to Gist
      const payloadToPush = {
        version: 1,
        lastUpdated: Date.now(),
        entries: state.entries,
        deleted: state.deleted,
        settings: state.settings
      };

      const patchRes = await fetch(`https://api.github.com/gists/${state.sync.gistId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${state.sync.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          description: 'Accountable Habit Tracker - Private Sync Store',
          files: {
            'accountable_data.json': {
              content: JSON.stringify(payloadToPush, null, 2)
            }
          }
        })
      });

      if (!patchRes.ok) {
        throw new Error(`Failed to upload to Gist (${patchRes.status})`);
      }

      state.sync.lastSync = Date.now();
      saveSyncConfig();
      if (!isAuto) showToast('Cloud sync completed successfully!', 'success');
    } catch (err) {
      console.error('Sync error:', err);
      if (!isAuto) showToast(`Sync error: ${err.message}`, 'error');
    } finally {
      state.sync.isSyncing = false;
      updateSyncUI();
    }
  }

  async function connectCloudSync() {
    const token = document.getElementById('input-github-token').value.trim();
    let gistId = document.getElementById('input-gist-id').value.trim();

    if (!token) {
      alert('Please enter your GitHub Personal Access Token.');
      return;
    }

    showToast('Connecting to GitHub Gist...', 'success');

    try {
      if (!gistId) {
        // Auto-create private Gist
        const createRes = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            description: 'Accountable Habit Tracker - Private Sync Store',
            public: false,
            files: {
              'accountable_data.json': {
                content: JSON.stringify({
                  version: 1,
                  lastUpdated: Date.now(),
                  entries: state.entries,
                  settings: state.settings
                }, null, 2)
              }
            }
          })
        });

        if (!createRes.ok) {
          throw new Error(`Failed to create private Gist (${createRes.status}). Ensure your token has the "gist" scope.`);
        }

        const newGist = await createRes.json();
        gistId = newGist.id;
        showToast('Created private Gist!', 'success');
      }

      state.sync.token = token;
      state.sync.gistId = gistId;
      state.sync.lastSync = Date.now();
      saveSyncConfig();

      await syncWithCloud(false);
      closeCloudSyncModal();
    } catch (err) {
      console.error(err);
      alert(`Connection failed: ${err.message}`);
    }
  }

  function disconnectSync() {
    if (confirm('Disconnect Cloud Sync on this device? (Your local data will not be deleted)')) {
      state.sync.token = '';
      state.sync.gistId = '';
      state.sync.lastSync = null;
      saveSyncConfig();
      showToast('Cloud Sync disconnected.', 'success');
    }
  }

  function generatePairingLink() {
    if (!state.sync.token || !state.sync.gistId) {
      alert('Please connect cloud sync first.');
      return;
    }
    let baseUrl = window.location.origin + window.location.pathname;
    if (window.location.protocol === 'file:' || baseUrl.includes('file:///')) {
      baseUrl = 'https://tiramiisuu.github.io/accountable/';
    }
    // Clean standard URL hash syntax so iOS / messaging apps never mangle characters
    const pairingUrl = `${baseUrl}#token=${state.sync.token}&gist=${state.sync.gistId}`;
    const box = document.getElementById('pairing-link-box');
    const input = document.getElementById('input-pairing-url');
    input.value = pairingUrl;
    box.classList.remove('hidden');
    input.select();
  }

  function copyPairingLink() {
    const input = document.getElementById('input-pairing-url');
    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
      showToast('Pairing link copied to clipboard!', 'success');
    }).catch(() => {
      document.execCommand('copy');
      showToast('Pairing link copied!', 'success');
    });
  }

  function handlePairingFromHash() {
    // Check both hash and search params, handling any URL-encoded characters
    const raw = decodeURIComponent(window.location.hash || window.location.search || '');
    if (!raw) return;

    let token = '';
    let gistId = '';

    // Format 1: #token=...&gist=... or ?token=...&gist=...
    if (raw.includes('token=') && raw.includes('gist=')) {
      const matchToken = raw.match(/token=([a-zA-Z0-9_]+)/);
      const matchGist = raw.match(/gist=([a-zA-Z0-9_]+)/);
      if (matchToken) token = matchToken[1];
      if (matchGist) gistId = matchGist[1];
    }
    // Format 2: #sync=TOKEN|GIST or #sync=TOKEN%7CGIST
    else if (raw.includes('sync=')) {
      const clean = raw.replace(/^.*?sync=/, '');
      const parts = clean.split(/[|]/);
      if (parts.length >= 2) {
        token = parts[0].trim();
        gistId = parts[1].trim();
      }
    }

    if (token && gistId) {
      state.sync.token = token;
      state.sync.gistId = gistId;
      saveSyncConfig();
      // Remove hash from URL without reloading
      window.history.replaceState(null, '', window.location.pathname);
      showToast('Connected via pairing link! Syncing data...', 'success');
      syncWithCloud(false);
    }
  }

  function scheduleAutoSync() {
    if (!state.sync.token || !state.sync.gistId) return;
    if (autoSyncTimeout) clearTimeout(autoSyncTimeout);
    autoSyncTimeout = setTimeout(() => {
      syncWithCloud(true);
    }, 1800);
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost')) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
          console.log('ServiceWorker registration skipped:', err);
        });
      });
    }
  }

  // --- Toast Notification ---
  function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span>${type === 'success' ? '&check;' : '&cross;'}</span>
      <span>${msg}</span>
    `;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, 3200);
  }

  // --- Master Render Function ---
  function renderAll() {
    renderKPIs();
    renderWillpower();
    renderHeatmap();
    renderChart();
    renderTable();
  }

  // --- Keyboard Shortcuts ---
  function setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const modal = document.getElementById('modal-day-edit');
      const isModalOpen = !modal.classList.contains('hidden');

      if (isModalOpen) {
        // If typing inside the notes textarea, don't trigger hotkeys
        if (e.target.id === 'modal-input-notes') {
          if (e.key === 'Escape') closeDayEditModal();
          return;
        }

        if (e.key === '1') {
          selectStatusButton('clean');
        } else if (e.key === '2') {
          selectStatusButton('minor');
        } else if (e.key === '3') {
          selectStatusButton('relapse');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          saveCurrentEntry(1); // Save and next
        } else if (e.key === 'Escape') {
          closeDayEditModal();
        }
      } else {
        // Global hotkey: 't' to log today
        if (e.key === 't' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
          openDayEditModal(getTodayStr());
        }
      }
    });
  }

  // --- Event Listeners Initialization ---
  function setupEvents() {
    // Header actions
    document.getElementById('btn-quick-log').addEventListener('click', () => openDayEditModal(getTodayStr()));
    document.getElementById('btn-batch-fill').addEventListener('click', openBatchModal);
    document.getElementById('btn-export-excel').addEventListener('click', exportToExcel);

    // Dropdown toggle
    const moreBtn = document.getElementById('btn-more-actions');
    const moreMenu = document.getElementById('more-dropdown-menu');
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moreMenu.classList.toggle('hidden');
    });
    window.addEventListener('click', () => {
      moreMenu.classList.add('hidden');
    });

    document.getElementById('btn-export-json').addEventListener('click', exportJSON);
    document.getElementById('input-import-json').addEventListener('change', (e) => {
      if (e.target.files.length > 0) importJSON(e.target.files[0]);
    });
    const loadStareBeneBtn = document.getElementById('btn-load-starebene');
    if (loadStareBeneBtn) {
      loadStareBeneBtn.addEventListener('click', () => {
        if (typeof PRELOADED_ENTRIES !== 'undefined') {
          if (confirm('Merge the 313 imported entries from "Stare Bene" into your history? (Your manual edits will be preserved)')) {
            state.entries = { ...PRELOADED_ENTRIES, ...state.entries };
            localStorage.setItem(STORAGE_KEY_MERGED_STARE_BENE, 'true');
            saveData();
            recalculateMomentum();
            renderAll();
            showToast('Merged 313 entries from "Stare Bene"!', 'success');
          }
        }
      });
    }
    document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
    document.getElementById('btn-reset-data').addEventListener('click', clearAllData);

    // Chart Range Toggles
    const rangeGroup = document.getElementById('chart-range-group');
    rangeGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-toggle');
      if (!btn) return;
      rangeGroup.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.chartRange = btn.dataset.range;
      renderChart();
    });

    // Heatmap Controls
    document.getElementById('btn-heatmap-prev-year').addEventListener('click', () => {
      state.heatmapMode = 'year';
      state.heatmapYear--;
      renderHeatmap();
    });
    document.getElementById('btn-heatmap-next-year').addEventListener('click', () => {
      state.heatmapMode = 'year';
      state.heatmapYear++;
      renderHeatmap();
    });
    document.getElementById('btn-heatmap-rolling').addEventListener('click', () => {
      state.heatmapMode = 'rolling';
      renderHeatmap();
    });

    // Day Edit Modal Controls
    document.getElementById('modal-day-close').addEventListener('click', closeDayEditModal);
    document.getElementById('modal-input-date').addEventListener('change', (e) => {
      if (e.target.value) openDayEditModal(e.target.value);
    });

    document.querySelectorAll('.status-btn').forEach(btn => {
      btn.addEventListener('click', () => selectStatusButton(btn.dataset.status));
    });

    document.getElementById('modal-btn-save').addEventListener('click', () => saveCurrentEntry(0));
    document.getElementById('modal-btn-save-next').addEventListener('click', () => saveCurrentEntry(1));
    document.getElementById('modal-btn-save-prev').addEventListener('click', () => saveCurrentEntry(-1));
    document.getElementById('modal-btn-delete').addEventListener('click', () => deleteEntry(state.editingDate));

    // Batch Modal Controls
    document.getElementById('modal-batch-close').addEventListener('click', closeBatchModal);
    document.getElementById('modal-batch-cancel').addEventListener('click', closeBatchModal);
    document.getElementById('modal-batch-apply').addEventListener('click', applyBatchFill);
    document.querySelectorAll('.btn-batch-status').forEach(btn => {
      btn.addEventListener('click', () => selectBatchStatusButton(btn.dataset.batchStatus));
    });

    // Settings Modal Controls
    document.getElementById('modal-settings-close').addEventListener('click', closeSettingsModal);
    document.getElementById('modal-settings-save').addEventListener('click', saveSettings);
    document.getElementById('modal-settings-reset').addEventListener('click', () => {
      state.settings = { ...DEFAULT_SETTINGS };
      openSettingsModal();
    });

    document.getElementById('setting-alpha-up').addEventListener('input', (e) => {
      document.getElementById('setting-alpha-up-val').textContent = `${Math.round(parseFloat(e.target.value) * 100)}%`;
    });
    document.getElementById('setting-alpha-down').addEventListener('input', (e) => {
      document.getElementById('setting-alpha-down-val').textContent = `${Math.round(parseFloat(e.target.value) * 100)}%`;
    });
    document.getElementById('setting-minor-val').addEventListener('input', (e) => {
      document.getElementById('setting-minor-val-val').textContent = `${e.target.value}%`;
    });

    // Table search & pagination
    document.getElementById('table-search').addEventListener('input', (e) => {
      state.tableSearch = e.target.value;
      state.tablePage = 1;
      renderTable();
    });
    document.getElementById('btn-table-prev').addEventListener('click', () => {
      if (state.tablePage > 1) {
        state.tablePage--;
        renderTable();
      }
    });
    document.getElementById('btn-table-next').addEventListener('click', () => {
      state.tablePage++;
      renderTable();
    });

    // Cloud Sync Modal Controls
    document.getElementById('btn-cloud-sync').addEventListener('click', openCloudSyncModal);
    document.getElementById('modal-cloud-close').addEventListener('click', closeCloudSyncModal);
    document.getElementById('modal-cloud-cancel').addEventListener('click', closeCloudSyncModal);
    document.getElementById('btn-save-sync').addEventListener('click', connectCloudSync);
    document.getElementById('btn-sync-now').addEventListener('click', () => syncWithCloud(false));
    document.getElementById('btn-disconnect-sync').addEventListener('click', disconnectSync);
    document.getElementById('btn-generate-pairing-link').addEventListener('click', generatePairingLink);
    document.getElementById('btn-copy-pairing-url').addEventListener('click', copyPairingLink);

    // Setup keyboard shortcuts
    setupKeyboardShortcuts();
  }

  // --- App Startup ---
  function init() {
    registerServiceWorker();
    loadData();
    recalculateMomentum();
    setupEvents();
    renderAll();
    loadSyncConfig();
    handlePairingFromHash();

    // Auto-sync when returning to the tab or app
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        syncWithCloud(true);
      }
    });

    // Expose needed functions globally for table button callbacks
    window.accountableApp = {
      openDayEditModal,
      deleteEntry
    };
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
