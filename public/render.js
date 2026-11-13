// Renders a /api/commute or /api/demo result. Shared by both pages; the
// simulated banner is driven by the data itself (source === "simulated").

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const dayLabel = (iso, checkedAt) => {
  const opts = { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" };
  const day = new Intl.DateTimeFormat("en-GB", opts).format(new Date(iso));
  const today = new Intl.DateTimeFormat("en-GB", opts).format(new Date(checkedAt));
  const tomorrow = new Intl.DateTimeFormat("en-GB", opts).format(new Date(new Date(checkedAt).getTime() + 86_400_000));
  return day === today ? `today (${day})` : day === tomorrow ? `tomorrow (${day})` : day;
};

const BASIS = { saved: "your saved time", timetable: "timetable", "live estimate": "live estimate" };
const basis = (b) => `<span class="basis">${esc(BASIS[b] ?? b)}</span>`;

const TRAIN_STATUS = {
  on_time: ["ok", "On time"],
  late: ["warn", null],
  delayed: ["warn", "Delayed (no estimate yet)"],
  cancelled: ["bad", "Cancelled"],
  cancelled_at_destination: ["bad", null],
  unknown: ["info", "Status unknown"],
  not_found: ["info", "Not on the live board"],
  unavailable: ["bad", "Live train information unavailable"],
};

function trainCard(r) {
  const t = r.train;
  if (r.mode === "planning") {
    return `<div class="banner plan">Live train information isn't available yet. Darwin only shows trains up to 2 hours ahead, so it will be available from ${esc(r.liveAvailableFrom.local)}. Until then, times below are the ones you saved.</div>`;
  }
  const [tone, label] = TRAIN_STATUS[t.status] ?? ["info", t.status];
  const text = t.status === "late" ? `${t.minutesLate} min late`
    : t.status === "cancelled_at_destination" ? `Doesn't reach ${r.journey.to.name}`
    : label;
  if (t.status === "not_found" || t.status === "unavailable") {
    return `<section class="card"><h2>Your train</h2>
      <div class="row"><span class="pill ${tone}">${esc(text)}</span></div>
      <p>${esc(t.message)}</p>
      ${t.otherServices?.length ? `<p class="muted small">On the board now: ${t.otherServices.map(esc).join(", ")}</p>` : ""}
    </section>`;
  }
  return `<section class="card"><h2>Your train</h2>
    <div class="row"><span class="pill ${tone}">${esc(text)}</span>
      ${t.mode === "bus" ? `<span class="pill warn">Replacement bus</span>` : ""}
      <span class="muted small">${esc(t.operator)} to ${esc(t.destinationName)}${t.platform ? ` · platform ${esc(t.platform)}` : ""}</span></div>
    <div class="times">
      <span></span><span class="head">Scheduled</span><span class="head">Expected</span>
      <span>Depart ${esc(r.journey.from.name)}</span><span>${esc(t.scheduledDeparture)}</span><span>${esc(t.expectedDeparture)}</span>
      <span>Arrive ${esc(r.journey.to.name)}</span><span>${esc(t.scheduledArrival ?? "-")}</span><span>${esc(t.expectedArrival ?? "-")}</span>
    </div>
    ${t.reason ? `<p class="small">${esc(t.reason)}</p>` : ""}
  </section>`;
}

function weatherBlock(w, stationName, basisKey) {
  const c = w.conditions;
  const where = w.forecastPoint
    ? `<p class="muted small">Forecast point: ${esc(w.forecastPoint.name)}, ${(w.forecastPoint.distanceMetres / 1000).toFixed(1)} km from the station</p>`
    : "";
  if (!c) return `<div><h2>${esc(stationName)} at ${esc(w.local)}${basis(basisKey)}</h2><p class="muted">${esc(w.message)}</p></div>`;
  return `<div>
    <h2>${esc(stationName)} at ${esc(w.local)}${basis(basisKey)}</h2>
    <div><strong>${esc(c.weather)}</strong>, ${c.temperatureC}°C (feels ${c.feelsLikeC}°C)</div>
    <dl>
      <dt>Chance of rain</dt><dd>${c.precipProbability}%</dd>
      <dt>Rain that hour</dt><dd>${c.rainMmThatHour} mm</dd>
      <dt>Gusts</dt><dd>${c.gustMph} mph</dd>
    </dl>
    ${c.flags.length ? `<div class="flags">${c.flags.map((f) => `<span class="pill warn">${esc(f)}</span>`).join("")}</div>` : `<span class="pill ok">Nothing to flag</span>`}
    ${where}
  </div>`;
}

export function renderResult(r) {
  const sim = r.source === "simulated";
  const j = r.journey;
  return `
    ${sim ? `<div class="banner sim">SIMULATED DATA. This is a test scenario, not live information.${r.scenario ? ` ${esc(r.scenario.description)}` : ""}</div>` : ""}
    <section class="card">
      <h2>${esc(j.from.name)} → ${esc(j.to.name)}</h2>
      <div>Departing ${esc(j.departure.local)} ${basis(j.departure.basis)} ${esc(dayLabel(j.departure.time, r.checkedAt))},
        arriving ${esc(j.arrival.local)} ${basis(j.arrival.basis)}</div>
      ${r.notes.map((n) => `<p class="small"><strong>Note:</strong> ${esc(n)}</p>`).join("")}
    </section>
    ${trainCard(r)}
    <section class="card">
      <div class="weather">
        ${weatherBlock(r.weather.departure, j.from.name, j.departure.basis)}
        ${weatherBlock(r.weather.arrival, j.to.name, j.arrival.basis)}
      </div>
      <p class="muted small">Heads-ups are this app's own thresholds applied to the forecast, not Met Office warnings.</p>
    </section>
    ${r.networkMessages.length ? `<section class="card"><details><summary>Messages for ${esc(j.from.name)} station (${r.networkMessages.length})</summary>
      <p class="muted small">National Rail shows these at the station. They may not be about your route.</p>
      <ul>${r.networkMessages.map((m) => `<li class="small">${esc(m)}</li>`).join("")}</ul></details></section>` : ""}
    <section class="card small">
      <strong>Not checked by this app:</strong>
      <ul>${r.notChecked.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      <span class="muted">${sim ? "Simulated clock" : "Checked"}: ${esc(new Date(r.checkedAt).toLocaleString("en-GB", { timeZone: "Europe/London" }))}</span>
    </section>`;
}

export async function getJSON(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({ error: `Unexpected response (${res.status})` }));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}
