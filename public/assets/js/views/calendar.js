// Calendar view: 12-month year overview, month grid with markers, selected-day inspector,
// month arrows and year navigation. Every control is a plain link to a hash route, so the
// position is shareable and keyboard users get ordinary link behaviour.
import { h } from '../dom.js';
import { MAX_YEAR, MIN_YEAR, defaultDay, defaultPosition, monthGrid, monthView, shiftMonth, yearView } from '../calendar-model.js';
import { MONTHS, WEEKDAYS, formatLongDay, formatMonth, formatWhen, plural } from '../format.js';
import { hrefFor, sermonHref } from '../router.js';
import { libraryTabs } from './library.js';

const calendarHref = (y, m, d) => hrefFor({ name: 'library', view: 'calendar', y, m, d });

function eventItem(event, showDate = false) {
  const detail = [event.place_name, event.occasion, event.version_label && `Version: ${event.version_label}`].filter(Boolean).join(' · ');
  return h('li', { class: 'event-item' },
    h('a', { href: sermonHref(event.sermon_id) }, event.sermon_title),
    event.sermon_archived ? h('span', { class: 'pill pill-warn' }, 'Archived') : null,
    event.date_precision === 'needs_review' ? h('span', { class: 'pill pill-warn' }, 'Date needs review') : null,
    showDate ? h('span', { class: 'event-detail' }, formatWhen(event.preached_on, event.date_precision)) : null,
    detail ? h('span', { class: 'event-detail' }, detail) : null,
    event.raw_date ? h('span', { class: 'event-detail' }, `Recorded as “${event.raw_date}”`) : null);
}

function navLink(label, href, focusKey, disabled, text) {
  return disabled
    ? h('span', { class: 'nav-arrow is-disabled', 'aria-hidden': 'true' }, text)
    : h('a', { class: 'nav-arrow', href, 'aria-label': label, 'data-focus-key': focusKey }, text);
}

export function calendarPage(ctx) {
  const { route, today, index } = ctx;
  const position = route.y ? { y: route.y, m: route.m } : defaultPosition(index, today);
  const { y, m } = position;
  const month = monthView(index, y, m);
  const year = yearView(index, y);
  const selected = route.d ?? defaultDay(month);
  const selectedEvents = selected ? month.days.get(selected) || [] : [];
  const prev = shiftMonth(y, m, -1), next = shiftMonth(y, m, 1);
  const atStart = prev.y === y && prev.m === m, atEnd = next.y === y && next.m === m;
  const todayKey = today;

  const grid = h('table', { class: 'month-grid' },
    h('caption', { class: 'sr-only' }, `${formatMonth(y, m)} preaching calendar`),
    h('thead', null, h('tr', null, ...WEEKDAYS.map(day => h('th', { scope: 'col' }, day)))),
    h('tbody', null, ...monthGrid(y, m).map(week => h('tr', null, ...week.map(cell => {
      if (!cell) return h('td', { class: 'pad' });
      const events = month.days.get(cell.date);
      if (!events) return h('td', null, h('span', { class: 'day-cell' + (cell.date === todayKey ? ' is-today' : '') }, h('span', { class: 'day-num' }, cell.day)));
      return h('td', null, h('a', {
        class: 'day-cell has-event' + (cell.date === selected ? ' is-selected' : '') + (cell.date === todayKey ? ' is-today' : ''),
        href: calendarHref(y, m, cell.date), 'data-focus-key': 'day-' + cell.date,
        'aria-current': cell.date === selected ? 'true' : null,
        'aria-label': `${formatLongDay(cell.date)}, ${plural(events.length, 'preaching')}`
      },
      h('span', { class: 'day-num' }, cell.day),
      h('span', { class: 'markers', 'aria-hidden': 'true' },
        ...events.slice(0, 3).map(event => h('i', { class: event.date_precision === 'needs_review' ? 'marker-review' : null })),
        events.length > 3 ? h('b', null, `+${events.length - 3}`) : null)));
    })))));

  const undatedGroups = [
    [`Recorded for ${formatMonth(y, m)} without a day`, month.monthOnly],
    [`Recorded for ${y} without a month`, year.yearOnly]
  ].filter(([, events]) => events.length);

  return h('div', { class: 'library' },
    h('div', { class: 'toolbar' }, libraryTabs('calendar')),
    h('section', { class: 'hybrid-calendar', 'aria-labelledby': 'calendar-title' },
      h('div', { class: 'calendar-story' },
        h('div', null,
          h('p', { class: 'eyebrow' }, 'THE CHRONICLE'),
          h('h2', { id: 'calendar-title' }, 'Preaching calendar'),
          h('p', null, 'Every day a message was preached, linked back to its sermon record.')),
        h('div', { class: 'calendar-spark', 'aria-hidden': 'true' }, '✳')),
      h('div', { class: 'hybrid-yearmap' },
        h('div', { class: 'mosaic-head' },
          navLink(`Previous year, ${y - 1}`, calendarHref(y - 1, m), 'prev-year', y <= MIN_YEAR, '‹'),
          h('h3', null, String(y)),
          navLink(`Next year, ${y + 1}`, calendarHref(y + 1, m), 'next-year', y >= MAX_YEAR, '›'),
          h('span', null, `${plural(year.total, 'preaching')} in ${y}`)),
        h('ol', { class: 'mosaic' }, ...year.months.map(tile => h('li', null, h('a', {
          class: 'mosaic-month', href: calendarHref(y, tile.month), 'data-focus-key': 'month-' + tile.month,
          'aria-current': tile.month === m ? 'true' : null,
          'aria-label': `${MONTHS[tile.month - 1]} ${y}, ${plural(tile.count, 'preaching')}`
        }, h('span', null, MONTHS[tile.month - 1].slice(0, 3)), h('b', null, String(tile.count)), h('i', { style: { '--level': Math.round(tile.level * 100) + '%' } })))))),
      h('div', { class: 'calendar-layout' },
        h('div', { class: 'calendar-main' },
          h('div', { class: 'month-head' },
            navLink(`Previous month, ${formatMonth(prev.y, prev.m)}`, calendarHref(prev.y, prev.m), 'prev-month', atStart, '‹'),
            h('h3', { 'aria-live': 'polite' }, formatMonth(y, m)),
            navLink(`Next month, ${formatMonth(next.y, next.m)}`, calendarHref(next.y, next.m), 'next-month', atEnd, '›'),
            h('span', { class: 'month-count' }, plural(month.count, 'preaching'))),
          grid),
        h('aside', { class: 'day-inspector', 'aria-label': 'Selected day' },
          selected
            ? [h('h3', null, formatLongDay(selected)),
              selectedEvents.length
                ? h('ul', { class: 'event-list' }, ...selectedEvents.map(event => eventItem(event)))
                : h('p', { class: 'muted' }, 'No preachings recorded on this day.')]
            : [h('h3', null, 'Select a day'),
              h('p', { class: 'muted' }, month.count ? 'Choose a marked day to see what was preached.' : `Nothing recorded for ${formatMonth(y, m)}.`)])),
      undatedGroups.length || index.undated.length
        ? h('div', { class: 'undated-block' },
          ...undatedGroups.map(([title, events]) => h('section', null, h('h4', null, title), h('ul', { class: 'event-list' }, ...events.map(event => eventItem(event, true))))),
          index.undated.length ? h('p', { class: 'muted' }, `${plural(index.undated.length, 'preaching')} in this archive ${index.undated.length === 1 ? 'has' : 'have'} no date. Open the sermon to review ${index.undated.length === 1 ? 'it' : 'them'}.`) : null)
        : null));
}

