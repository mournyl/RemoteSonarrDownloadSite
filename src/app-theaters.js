// ---------- Theaters near you (shown on Movies → In Theaters) ----------
const theaterList = $("#theaterList"), zipInput = $("#zip"), radiusSel = $("#radius");

function updateTheaterBar() {
  const box = document.getElementById("theaters");
  if (box) box.hidden = !(state.type === "movie" && state.list === "movie/now_playing" && !state.query);
}

async function findTheaters(e) {
  if (e) e.preventDefault();
  const zip = zipInput.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    theaterList.innerHTML = `<p class="th-note">Enter a 5-digit ZIP code.</p>`;
    return;
  }
  try { localStorage.setItem("zip", zip); } catch {}
  theaterList.innerHTML = `<p class="th-note">Finding theaters near ${esc(zip)}…</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/theaters?zip=${zip}&radius=${radiusSel.value}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    if (!data.theaters.length) {
      theaterList.innerHTML = `<p class="th-note">No theaters found within ${data.radius} miles of ${esc(data.place)}.</p>`;
      return;
    }
    theaterList.innerHTML =
      `<p class="th-note">${data.theaters.length} theater${data.theaters.length === 1 ? "" : "s"} near ${esc(data.place)}</p><ul>` +
      data.theaters.map((t) => {
        const addr = [t.street, t.city].filter(Boolean).join(", ");
        const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr ? `${t.name}, ${addr}` : `${t.lat},${t.lon}`)}`;
        const times = `https://www.google.com/search?q=${encodeURIComponent(`${t.name} ${t.city} showtimes`)}`;
        return `<li>
          <div class="th-head"><span class="th-name">${esc(t.name)}</span><span class="th-dist">${t.miles} mi</span></div>
          ${addr ? `<div class="th-addr">${esc(addr)}</div>` : ""}
          <div class="th-links">
            <a href="${times}" target="_blank" rel="noopener">Showtimes</a>
            <a href="${maps}" target="_blank" rel="noopener">Directions</a>
            ${t.website ? `<a href="${esc(t.website)}" target="_blank" rel="noopener">Website</a>` : ""}
            ${t.phone ? `<a href="tel:${esc(t.phone.replace(/[^\d+]/g, ""))}">${esc(t.phone)}</a>` : ""}
          </div>
        </li>`;
      }).join("") + `</ul>`;
  } catch (err) {
    theaterList.innerHTML = `<p class="th-note">Couldn't load theaters: ${esc(err.message)}</p>`;
  }
}

$("#zipForm").addEventListener("submit", findTheaters);
try { zipInput.value = localStorage.getItem("zip") || ""; } catch {}
