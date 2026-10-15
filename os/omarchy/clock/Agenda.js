// Phosphor-OS: the events behind the clock's calendar popup (not part of Omarchy). Pure, like Model.js, so
// tests/calendar-agenda.test.mjs can run it under node. Input: the text of calendar.json, which the Phosphor-OS
// server writes: {updated, calendars:[name...], events:[{start, end, allDay, title, location, calendar}]}.
// Output: events per calendar day, ready to draw.

function pad2(n) { return (n < 10 ? "0" : "") + n }

function dayKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) }

// 12-hour like the bar ("h:mm AP").
function clock(d) {
  var h = d.getHours()
  return (h % 12 || 12) + ":" + pad2(d.getMinutes()) + " " + (h < 12 ? "AM" : "PM")
}

// A link into Google Calendar from the cache (EDIT, + NEW) or "": anything else is dropped, so the popup only ever
// opens Google Calendar addresses, and never through a shell (the panel passes it to xdg-open as one argument).
function googleLink(u) {
  return typeof u === "string" && /^https:\/\/calendar\.google\.com\/calendar\/[^\s]*$/.test(u) ? u : ""
}

// The draft address for an all-day event on a day: the cache's newUrl (ends in "dates=") + "YYYYMMDD/<next day>".
// key is "yyyy-MM-dd"; "" when there is no address or the key is not a day.
function newEventUrl(base, key) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key))
  if (!base || !m) return ""
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  var n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  function ymd(x) { return x.getFullYear() + pad2(x.getMonth() + 1) + pad2(x.getDate()) }
  return base + ymd(d) + "/" + ymd(n)
}

// text -> { updated (ms, 0 if unknown), calendars: [name], newUrl ("" if none), days: { "yyyy-MM-dd": [row] } }. Never throws: a missing
// or broken file is an empty cache. A row: { time, title, location, edit (Google Calendar link or ""), calendar (index in calendars) }. Rows of a day
// are sorted all-day first, then by start. An event that runs past midnight shows on every day it covers (end excluded).
function load(text) {
  var out = { updated: 0, calendars: [], newUrl: "", days: {} }
  var data
  try { data = JSON.parse(text) } catch (e) { return out }
  if (!data || !Array.isArray(data.events)) return out
  out.updated = Number(data.updated) || 0
  out.calendars = Array.isArray(data.calendars) ? data.calendars.map(String) : []
  out.newUrl = googleLink(data.newUrl)

  var staged = {}
  data.events.forEach(function(ev) {
    var start = new Date(ev.start), end = new Date(ev.end)
    if (isNaN(start.getTime())) return
    if (isNaN(end.getTime()) || end < start) end = start
    var cal = out.calendars.indexOf(ev.calendar)
    if (cal < 0 && ev.calendar) { out.calendars.push(String(ev.calendar)); cal = out.calendars.length - 1 }
    var day = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    for (var n = 0; n < 62; n++) { // a runaway end date cannot hang the bar
      var key = dayKey(day)
      var next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
      var first = n === 0, last = end <= next
      var time = ev.allDay ? "all day" : first ? clock(start) : last ? "until " + clock(end) : "all day"
      var order = ev.allDay || (!first && !last) ? 0 : 1
      ;(staged[key] = staged[key] || []).push({
        time: time, title: String(ev.title || ""), location: String(ev.location || ""), edit: googleLink(ev.edit),
        calendar: Math.max(cal, 0), order: order, at: first ? start.getTime() : day.getTime()
      })
      if (last) break
      day = next
    }
  })
  Object.keys(staged).forEach(function(key) {
    staged[key].sort(function(a, b) { return a.order - b.order || a.at - b.at || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) })
    out.days[key] = staged[key].map(function(r) { return { time: r.time, title: r.title, location: r.location, edit: r.edit, calendar: r.calendar } })
  })
  return out
}

// The calendars with an event on a day, once each, in calendar order: the dots under the day.
function calendarsOn(rows) {
  var seen = {}
  ;(rows || []).forEach(function(r) { seen[r.calendar] = true })
  return Object.keys(seen).map(Number).sort(function(a, b) { return a - b })
}

// "updated 9:40 AM" once the cache is older than maxAgeMs, else "". 0 (never written) says nothing.
function staleNote(updated, now, maxAgeMs) {
  if (!updated || now - updated <= maxAgeMs) return ""
  return "updated " + clock(new Date(updated))
}

if (typeof module !== "undefined") {
  module.exports = { dayKey: dayKey, clock: clock, googleLink: googleLink, newEventUrl: newEventUrl, load: load, calendarsOn: calendarsOn, staleNote: staleNote }
}
