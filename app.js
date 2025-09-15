/* Military GPS Web App for GitHub Pages */

// Map style: dark military (MapLibre-compatible raster tiles from Carto/OSM alternatives)
// We will use Esri Satellite + OSM dark as examples with proper attribution.

let map, draw, drawnItems, trailLine, accuracyCircle;
let baseLayers = {};
let currentBaseKey = 'dark';
let trafficLayer = null;
let watchId = null;
let lastPosition = null;
let trackCoords = [];
let waypoints = [];
const WAYPOINTS_KEY = 'fieldgps.waypoints.v1';
const FORM_INFO_KEY = 'fieldgps.formInfo.v1';
let useOffline = false;
let offlineLayer = null;
let SQL = null;
let mbtilesDb = null;
const SETTINGS_KEY = 'fieldgps.settings.v1';
const UI_LAYER_KEY = 'fieldgps.ui.baseLayer.v1';
const UI_TRAFFIC_KEY = 'fieldgps.ui.traffic.v1';
let settings = { maxAccM: 20, alertRadiusM: 30 };
let speedHistory = []; // last N speeds (km/h)
let altHistory = [];   // last N altitudes (m)
const HIST_LIMIT = 60;
let followMode = false;
let trackingEnabled = true;
let navTarget = null; // {lat, lon, label} or null
let navLine = null;
let averaging = { active: false, samples: [] };
let loggingCsv = { active: false, rows: [] };
let nmea = { connected: false, sats: [], device: null, reader: null };
let fieldPolygon = null; // Polygon built from waypoints
let formInfo = { fullname: '', father: '', nid: '', region: '', parcelMain: '', parcelSub: '' };

// UTM helpers using proj4
function getUtmZone(longitude) {
  return Math.floor((longitude + 180) / 6) + 1;
}

function getUtmProj(longitude, latitude) {
  const zone = getUtmZone(longitude);
  const isNorthern = latitude >= 0;
  const projName = `+proj=utm +zone=${zone} ${isNorthern ? "+north" : "+south"} +datum=WGS84 +units=m +no_defs`;
  return { zone, proj: proj4("EPSG:4326", projName) };
}

function toUtm(lat, lon) {
  const { zone, proj } = getUtmProj(lon, lat);
  const [easting, northing] = proj.forward([lon, lat]);
  const band = latToBand(lat);
  return { zone, band, easting: Math.round(easting), northing: Math.round(northing) };
}

function latToBand(lat) {
  const bands = "CDEFGHJKLMNPQRSTUVWX"; // UTM bands
  const index = Math.floor((lat + 80) / 8);
  return bands[Math.max(0, Math.min(bands.length - 1, index))];
}

function fmt(n, digits = 6) { return n.toFixed(digits); }

function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
  }).setView([35.6892, 51.3890], 13);

  // Base layers (no API key): OSM, CARTO Dark, ESRI WorldImagery, and Stamen Toner Lite (traffic-like contrast)
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap', crossOrigin: true
  });
  const cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20, attribution: '© OpenStreetMap, © CARTO', crossOrigin: true
  });
  const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye', crossOrigin: true
  });
  const tonerLite = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner-lite/{z}/{x}/{y}.png', {
    maxZoom: 20, attribution: 'Map tiles by Stamen Design, CC BY 3.0 — Map data © OpenStreetMap', crossOrigin: true
  });
  const openTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, attribution: '© OpenTopoMap (CC-BY-SA)', crossOrigin: true
  });
  baseLayers = { dark: cartoDark, satellite: esriSat, osm: osm, light: tonerLite, terrain: openTopo };
  cartoDark.addTo(map);

  // Simple traffic-style overlay: use Stamen Toner Lines over base
  trafficLayer = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner-lines/{z}/{x}/{y}.png', {
    maxZoom: 20, opacity: 0.6, crossOrigin: true
  });

  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  draw = new L.Control.Draw({
    position: 'topleft',
    draw: {
      circle: false,
      marker: false,
      rectangle: false,
      circlemarker: false,
      polyline: { shapeOptions: { color: '#39ff14', weight: 3 } },
      polygon: { shapeOptions: { color: '#39ff14', weight: 2, fillOpacity: 0.1 } }
    },
    edit: { featureGroup: drawnItems }
  });
  map.addControl(draw);

  // Scale control
  L.control.scale({ imperial: false }).addTo(map);

  // Simple North arrow control (Leaflet is north-up; static arrow)
  const North = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      div.style.padding = '6px 8px';
      div.style.background = '#0a110d';
      div.style.border = '2px solid #556b2f';
      div.style.color = '#a6ff00';
      div.style.fontWeight = '800';
      div.innerHTML = 'N ↑';
      return div;
    }
  });
  map.addControl(new North());

  map.on(L.Draw.Event.CREATED, (e) => {
    const layer = e.layer;
    drawnItems.addLayer(layer);
    updateMeasurementOverlay(layer);
  });

  map.on(L.Draw.Event.EDITED, (e) => {
    Object.values(e.layers._layers).forEach((layer) => updateMeasurementOverlay(layer));
  });

  map.on('draw:drawvertex', () => {
    // Update live measures while drawing if possible
    const last = Object.values(drawnItems._layers).slice(-1)[0];
    if (last) updateMeasurementOverlay(last);
  });

  // Trail polyline with glow effect (duplicated polyline technique)
  trailLine = L.polyline([], { color: '#39ff14', weight: 3, opacity: 0.9 }).addTo(map);
}

function setBaseLayer(key) {
  if (!baseLayers[key]) return;
  // Remove any existing base layer
  Object.entries(baseLayers).forEach(([k, layer]) => { if (map.hasLayer(layer)) map.removeLayer(layer); });
  baseLayers[key].addTo(map);
  currentBaseKey = key;
  try { localStorage.setItem(UI_LAYER_KEY, key); } catch {}
  const sel = document.getElementById('layer-select');
  if (sel && sel.value !== key) sel.value = key;
}

function updateMeasurementOverlay(layer) {
  const el = document.getElementById('measure-overlay');
  let text = '';
  if (!layer) { el.classList.add('hidden'); return; }
  if (layer.getLatLngs) {
    const coords = layer.getLatLngs();
    let flat = coords;
    if (Array.isArray(coords[0])) flat = coords[0];
    if (flat.length >= 2) {
      const line = turf.lineString(flat.map(ll => [ll.lng, ll.lat]));
      const lengthM = turf.length(line, { units: 'kilometers' }) * 1000;
      text += `Length: ${lengthM.toFixed(1)} m\n`;
    }
    if (flat.length >= 3 && layer instanceof L.Polygon) {
      const poly = turf.polygon([[...flat.map(ll => [ll.lng, ll.lat]), [flat[0].lng, flat[0].lat]]]);
      const areaM2 = turf.area(poly);
      text += `Area: ${areaM2.toFixed(1)} m²`;
    }
  }
  if (text) {
    el.textContent = text;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function requestHighAccuracyPosition() {
  if (!('geolocation' in navigator)) {
    setGpsStatus(false);
    return;
  }
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 10000,
  });
}

function onPosition(pos) {
  const { latitude, longitude, altitude, accuracy, speed, heading } = pos.coords;
  lastPosition = pos;

  const utm = toUtm(latitude, longitude);
  document.getElementById('utm').textContent = `${utm.zone}${utm.band} ${utm.easting} ${utm.northing}`;
  document.getElementById('latlon').textContent = `${fmt(latitude, 6)}, ${fmt(longitude, 6)}`;
  document.getElementById('alt').textContent = altitude != null ? Math.round(altitude) : '—';
  document.getElementById('acc').textContent = accuracy != null ? Math.round(accuracy) : '—';
  const speedKmh = speed != null ? (speed * 3.6) : null;
  document.getElementById('speed').textContent = speedKmh != null ? speedKmh.toFixed(1) : '—';

  // Heading indicator
  const hdg = (heading != null && !Number.isNaN(heading)) ? heading : computeCourseFromTrack(latitude, longitude);
  setHeading(hdg);
  setNavArrow(hdg);

  // Trail update
  trackCoords.push([latitude, longitude]);
  trailLine.addLatLng([latitude, longitude]);

  // Accuracy circle
  if (!accuracyCircle) {
    accuracyCircle = L.circle([latitude, longitude], { radius: accuracy || 0, color: '#a6ff00', weight: 1, fillColor: '#a6ff00', fillOpacity: 0.1 }).addTo(map);
  } else {
    accuracyCircle.setLatLng([latitude, longitude]);
    if (accuracy != null) accuracyCircle.setRadius(accuracy);
  }

  // Center map on first fix
  if (trackCoords.length === 1 || followMode) { map.setView([latitude, longitude], followMode ? map.getZoom() : 17); }

  setGpsStatus(true);

  // Append history and render sparkline
  if (speedKmh != null) { speedHistory.push(speedKmh); if (speedHistory.length > HIST_LIMIT) speedHistory.shift(); }
  if (altitude != null) { altHistory.push(altitude); if (altHistory.length > HIST_LIMIT) altHistory.shift(); }
  renderSparkline();

  // Accuracy filter: ignore points worse than threshold for alerts
  if (accuracy != null && accuracy > settings.maxAccM) return;
  // Proximity alert
  checkProximityAlerts(latitude, longitude);

  // Navigation overlay
  updateNavigationOverlay(latitude, longitude);

  // Averaging
  if (averaging.active) {
    averaging.samples.push({ lat: latitude, lon: longitude, acc: accuracy ?? null });
    updateAveragingUI();
  }

  // CSV logging
  if (loggingCsv.active) {
    loggingCsv.rows.push(`${new Date(pos.timestamp).toISOString()},${latitude},${longitude},${altitude ?? ''},${accuracy ?? ''},${speedKmh ?? ''}`);
  }
}

function onPositionError(err) {
  console.warn('GPS error', err);
  setGpsStatus(false);
}

function computeCourseFromTrack(lat, lon) {
  if (trackCoords.length < 1) return null;
  const [pLat, pLon] = trackCoords[trackCoords.length - 1];
  const bearing = turf.bearing(turf.point([pLon, pLat]), turf.point([lon, lat]));
  return (bearing + 360) % 360;
}

function setHeading(deg) {
  const el = document.getElementById('heading');
  if (deg == null) { el.textContent = '—°'; return; }
  el.textContent = `${deg.toFixed(0)}°`;
  const red = document.getElementById('needle-red');
  const green = document.getElementById('needle-green');
  red.style.transform = `translate(-50%, -90%) rotate(${deg}deg)`;
  green.style.transform = `translate(-50%, -10%) rotate(${deg + 180}deg)`;
}

function setNavArrow(headingDeg) {
  const el = document.getElementById('nav-arrow'); if (!el) return;
  if (!navTarget || headingDeg == null) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  // Rotate arrow towards bearing to target minus current heading
  if (lastPosition && navTarget) {
    const { latitude, longitude } = lastPosition.coords;
    const from = turf.point([longitude, latitude]); const to = turf.point([navTarget.lon, navTarget.lat]);
    const bearing = (turf.bearing(from, to) + 360) % 360;
    const rel = ((bearing - headingDeg) + 360) % 360; // relative angle
    el.style.transform = `translateX(-50%) rotate(${rel}deg)`;
    const full = document.querySelector('.nav-full-arrow');
    const info = document.getElementById('nav-full-info');
    const d = turf.distance(from, to, { units: 'meters' });
    if (full) full.style.transform = `rotate(${rel}deg)`;
    if (info) info.textContent = `فاصله: ${d.toFixed(1)} m | سمت: ${bearing.toFixed(0)}°`;
  }
}

function setGpsStatus(ok) {
  const el = document.getElementById('gps-status');
  el.textContent = ok ? 'GPS' : 'GPS?';
  el.classList.toggle('offline', !ok);
  el.classList.toggle('online', ok);
  updateSatBadge();
}

function setOnlineStatus() {
  const el = document.getElementById('online-status');
  const online = navigator.onLine;
  el.textContent = online ? 'ONLINE' : 'OFFLINE';
  el.classList.toggle('online', online);
}

function updateSatBadge() {
  const el = document.getElementById('sat-status'); if (!el) return;
  const count = nmea.sats?.length || 0;
  const fix = lastPosition ? (lastPosition.coords.accuracy != null) : false;
  el.textContent = `SAT ${count}${nmea.connected ? '' : ''}`;
  el.classList.toggle('online', fix || nmea.connected);
}

function addWaypointFromCurrent() {
  if (!lastPosition) return;
  const { latitude, longitude, altitude, accuracy } = lastPosition.coords;
  const utm = toUtm(latitude, longitude);
  const wp = {
    id: Date.now().toString(),
    lat: latitude,
    lon: longitude,
    altitudeM: altitude ?? null,
    accuracyM: accuracy ?? null,
    utmZone: utm.zone,
    utmBand: utm.band,
    easting: utm.easting,
    northing: utm.northing,
    timestamp: new Date().toISOString(),
  };
  waypoints.push(wp);
  saveWaypoints();
  // Use vector-friendly circle marker so leaflet-image captures it
  L.circleMarker([wp.lat, wp.lon], { radius: 5, color: '#ff3b30', weight: 2, fillColor: '#ff3b30', fillOpacity: 0.6 }).addTo(map);
  renderWaypointList();
  hapticBeep();
}

function redCrossIcon() {
  // Simple red cross using a divIcon
  return L.divIcon({
    className: 'wp-cross',
    html: '<div style="position:relative;width:14px;height:14px;">\
            <div style="position:absolute;left:6px;top:0;width:2px;height:14px;background:#ff3b30;"></div>\
            <div style="position:absolute;left:0;top:6px;width:14px;height:2px;background:#ff3b30;"></div>\
          </div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
}

function renderWaypointList() {
  const ul = document.getElementById('waypoint-list');
  ul.innerHTML = '';
  waypoints.slice().reverse().forEach((w) => {
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.textContent = `${w.utmZone}${w.utmBand} ${w.easting} ${w.northing}`;
    left.style.fontFamily = 'IBM Plex Mono, monospace';
    const right = document.createElement('div');
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Zoom';
    btn.onclick = () => map.setView([w.lat, w.lon], 18);
    right.appendChild(btn);
    const nav = document.createElement('button');
    nav.className = 'btn';
    nav.textContent = 'ناوبری';
    nav.onclick = () => { setNavTarget(w.id); toast('ناوبری به نقطه فعال شد', 'success'); };
    right.appendChild(nav);
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'حذف';
    del.onclick = () => { waypoints = waypoints.filter(x => x.id !== w.id); saveWaypoints(); renderWaypointList(); };
    right.appendChild(del);
    li.appendChild(left); li.appendChild(right);
    ul.appendChild(li);
  });
}

function saveWaypoints() {
  try { localStorage.setItem(WAYPOINTS_KEY, JSON.stringify(waypoints)); } catch {}
}

function loadWaypoints() {
  try {
    const s = localStorage.getItem(WAYPOINTS_KEY);
    if (!s) return;
    waypoints = JSON.parse(s) || [];
    for (const w of waypoints) {
      L.circleMarker([w.lat, w.lon], { radius: 5, color: '#ff3b30', weight: 2, fillColor: '#ff3b30', fillOpacity: 0.6 }).addTo(map);
    }
    renderWaypointList();
  } catch {}
}

function saveFormInfo() {
  try { localStorage.setItem(FORM_INFO_KEY, JSON.stringify(formInfo)); } catch {}
}
function loadFormInfo() {
  try { const s = localStorage.getItem(FORM_INFO_KEY); if (s) formInfo = JSON.parse(s); } catch {}
}

function exportGPX() {
  const header = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="FieldGPS" xmlns="http://www.topografix.com/GPX/1/1">`;
  const pts = waypoints.map(w => `<wpt lat="${w.lat}" lon="${w.lon}"><time>${w.timestamp}</time><name>${w.id}</name></wpt>`).join('');
  const trkpts = trackCoords.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('');
  const trk = trackCoords.length ? `<trk><name>track</name><trkseg>${trkpts}</trkseg></trk>` : '';
  const xml = `${header}${pts}${trk}</gpx>`;
  downloadText('track.gpx', xml, 'application/gpx+xml');
}

function exportKML() {
  const header = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
  const pts = waypoints.map(w => `<Placemark><name>${w.id}</name><Point><coordinates>${w.lon},${w.lat},${w.altitudeM ?? 0}</coordinates></Point></Placemark>`).join('');
  const line = trackCoords.length ? `<Placemark><name>track</name><LineString><coordinates>${trackCoords.map(([lat, lon]) => `${lon},${lat},0`).join(' ')}</coordinates></LineString></Placemark>` : '';
  // Polygon from drawnItems if exists
  let polyStr = '';
  drawnItems.eachLayer((layer) => {
    if (layer instanceof L.Polygon && !polyStr) {
      const rings = layer.getLatLngs(); const flat = Array.isArray(rings[0]) ? rings[0] : rings;
      const coords = [...flat.map(ll=>`${ll.lng},${ll.lat},0`), `${flat[0].lng},${flat[0].lat},0`].join(' ');
      polyStr = `<Placemark><name>boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    }
  });
  const xml = `${header}${pts}${line}${polyStr}</Document></kml>`;
  downloadText('track.kml', xml, 'application/vnd.google-earth.kml+xml');
}

function exportDXF() {
  // Minimal DXF R12 with POINTs for waypoints and a LWPOLYLINE for track
  const header = [
    '0','SECTION','2','HEADER','0','ENDSEC',
    '0','SECTION','2','TABLES','0','ENDSEC',
    '0','SECTION','2','ENTITIES'
  ];
  const ents = [];
  // Waypoints as POINT on layer WAYPOINTS
  for (const w of waypoints) {
    ents.push('0','POINT','8','WAYPOINTS','10',String(w.lon),'20',String(w.lat),'30',String(w.altitudeM ?? 0));
  }
  // Track as LWPOLYLINE on layer TRACK (lon/lat space)
  if (trackCoords.length > 1) {
    ents.push('0','LWPOLYLINE','8','TRACK','90',String(trackCoords.length),'70','0');
    for (const [lat, lon] of trackCoords) {
      ents.push('10',String(lon),'20',String(lat));
    }
  }
  const footer = ['0','ENDSEC','0','EOF'];
  const dxf = [...header, ...ents, ...footer].join('\n');
  downloadText('data.dxf', dxf, 'image/vnd.dxf');
}

function exportDXFDrawings(utmZone) {
  // Gather polylines/polygons from drawnItems and export as DXF.
  // If utmZone provided, convert lat/lon to UTM meters for that zone (north hemisphere by default).
  const header = [
    '0','SECTION','2','HEADER','0','ENDSEC',
    '0','SECTION','2','TABLES','0','ENDSEC',
    '0','SECTION','2','ENTITIES'
  ];
  const ents = [];
  let forward = null;
  if (Number.isFinite(utmZone)) {
    const projStr = `+proj=utm +zone=${utmZone} +north +datum=WGS84 +units=m +no_defs`;
    forward = proj4('EPSG:4326', projStr);
  }
  drawnItems.eachLayer((layer) => {
    if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
      const pts = layer.getLatLngs();
      const xy = pts.map(ll => forward ? forward.forward([ll.lng, ll.lat]) : [ll.lng, ll.lat]);
      ents.push('0','LWPOLYLINE','8','DRAWINGS','90',String(xy.length),'70','0');
      for (const [x,y] of xy) { ents.push('10',String(x),'20',String(y)); }
    }
    if (layer instanceof L.Polygon) {
      const rings = layer.getLatLngs();
      const flat = Array.isArray(rings[0]) ? rings[0] : rings;
      const xy = flat.map(ll => forward ? forward.forward([ll.lng, ll.lat]) : [ll.lng, ll.lat]);
      ents.push('0','LWPOLYLINE','8','DRAWINGS','90',String(xy.length + 1),'70','1');
      for (const [x,y] of xy) { ents.push('10',String(x),'20',String(y)); }
      const [fx,fy] = xy[0]; ents.push('10',String(fx),'20',String(fy));
    }
  });
  const footer = ['0','ENDSEC','0','EOF'];
  const dxf = [...header, ...ents, ...footer].join('\n');
  const name = Number.isFinite(utmZone) ? `drawings_utm${utmZone}.dxf` : 'drawings_wgs84.dxf';
  downloadText(name, dxf, 'image/vnd.dxf');
}

function buildDXFFromDrawings(utmZone) {
  const header = [ '0','SECTION','2','HEADER','0','ENDSEC','0','SECTION','2','TABLES','0','ENDSEC','0','SECTION','2','ENTITIES' ];
  const ents = [];
  let forward = null;
  if (Number.isFinite(utmZone)) {
    const projStr = `+proj=utm +zone=${utmZone} +north +datum=WGS84 +units=m +no_defs`;
    forward = proj4('EPSG:4326', projStr);
  }
  drawnItems.eachLayer((layer) => {
    if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
      const pts = layer.getLatLngs();
      const xy = pts.map(ll => forward ? forward.forward([ll.lng, ll.lat]) : [ll.lng, ll.lat]);
      ents.push('0','LWPOLYLINE','8','DRAWINGS','90',String(xy.length),'70','0');
      for (const [x,y] of xy) { ents.push('10',String(x),'20',String(y)); }
    }
    if (layer instanceof L.Polygon) {
      const rings = layer.getLatLngs();
      const flat = Array.isArray(rings[0]) ? rings[0] : rings;
      const xy = flat.map(ll => forward ? forward.forward([ll.lng, ll.lat]) : [ll.lng, ll.lat]);
      ents.push('0','LWPOLYLINE','8','DRAWINGS','90',String(xy.length + 1),'70','1');
      for (const [x,y] of xy) { ents.push('10',String(x),'20',String(y)); }
      const [fx,fy] = xy[0]; ents.push('10',String(fx),'20',String(fy));
    }
  });
  const footer = ['0','ENDSEC','0','EOF'];
  return [...header, ...ents, ...footer].join('\n');
}

async function shareFilesIfSupported() {
  if (!('canShare' in navigator) || !('share' in navigator)) { toast('اشتراک در این دستگاه پشتیبانی نمی‌شود', 'warn'); return; }
  const files = [];
  // A4 PNG
  await renderA4Structured();
  const c = document.getElementById('a4-canvas');
  const pngBlob = await (await fetch(c.toDataURL('image/png'))).blob();
  files.push(new File([pngBlob], 'map-a4.png', { type: 'image/png' }));
  // KML
  const kmlHeader = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>`;
  const kmlPts = waypoints.map(w => `<Placemark><name>${w.id}</name><Point><coordinates>${w.lon},${w.lat},${w.altitudeM ?? 0}</coordinates></Point></Placemark>`).join('');
  const kmlXml = `${kmlHeader}${kmlPts}</Document></kml>`;
  files.push(new File([kmlXml], 'points.kml', { type: 'application/vnd.google-earth.kml+xml' }));
  // DXF from drawings
  const dxfText = buildDXFFromDrawings();
  files.push(new File([dxfText], 'drawings.dxf', { type: 'image/vnd.dxf' }));
  if (navigator.canShare({ files })) {
    await navigator.share({ files, title: 'Field GPS', text: 'نقشه و فایل‌ها' });
  } else {
    toast('اشتراک فایل‌ها امکان‌پذیر نیست', 'warn');
  }
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function onImportFile(ev) {
  const file = ev.target.files[0]; if (!file) return;
  const name = file.name.toLowerCase();
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    try {
      if (name.endsWith('.gpx')) importGPX(text);
      else if (name.endsWith('.kml')) importKML(text);
      toast('داده وارد شد', 'success');
    } catch (e) { console.warn(e); toast('خطا در ورود فایل', 'error'); }
  };
  reader.readAsText(file);
}

function importGPX(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const wpts = Array.from(doc.getElementsByTagName('wpt'));
  for (const w of wpts) {
    const lat = parseFloat(w.getAttribute('lat')); const lon = parseFloat(w.getAttribute('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) { addWaypointRaw(lat, lon, null); }
  }
  const trkpts = Array.from(doc.getElementsByTagName('trkpt')).map(n => [parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon'))]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (trkpts.length) { trackCoords = trkpts; trailLine.setLatLngs(trkpts); }
}

function importKML(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const points = Array.from(doc.getElementsByTagName('Point'));
  for (const p of points) {
    const coords = p.getElementsByTagName('coordinates')[0]?.textContent?.trim();
    if (!coords) continue; const [lon, lat] = coords.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) { addWaypointRaw(lat, lon, null); }
  }
  const lines = Array.from(doc.getElementsByTagName('LineString'));
  for (const l of lines) {
    const coordsStr = l.getElementsByTagName('coordinates')[0]?.textContent?.trim();
    if (!coordsStr) continue;
    const pts = coordsStr.split(/\s+/).map(s => s.split(',').map(Number)).map(([lon, lat]) => [lat, lon]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length) { trackCoords = pts; trailLine.setLatLngs(pts); }
  }
}

function addWaypointRaw(lat, lon, alt) {
  const utm = toUtm(lat, lon);
  const wp = { id: Date.now().toString() + Math.random().toString(36).slice(2,6), lat, lon, altitudeM: alt ?? null, accuracyM: null, utmZone: utm.zone, utmBand: utm.band, easting: utm.easting, northing: utm.northing, timestamp: new Date().toISOString() };
  waypoints.push(wp); saveWaypoints(); L.circleMarker([lat, lon], { radius: 5, color: '#ff3b30', weight: 2, fillColor: '#ff3b30', fillOpacity: 0.6 }).addTo(map); renderWaypointList();
}

function setNavTarget(target) {
  // target can be a waypoint id or an object {lat, lon, label}
  if (typeof target === 'string') {
    const w = waypoints.find(x => x.id === target);
    navTarget = w ? { lat: w.lat, lon: w.lon, label: w.id } : null;
  } else {
    navTarget = target;
  }
  if (navLine) { map.removeLayer(navLine); navLine = null; }
}

function updateNavigationOverlay(lat, lon) {
  const el = document.getElementById('nav-overlay'); if (!el) return;
  if (!navTarget) { el.classList.add('hidden'); if (navLine) { map.removeLayer(navLine); navLine = null; } return; }
  const target = navTarget;
  const from = turf.point([lon, lat]); const to = turf.point([target.lon, target.lat]);
  const d = turf.distance(from, to, { units: 'meters' });
  const b = (turf.bearing(from, to) + 360) % 360;
  const label = target.label || 'هدف';
  el.textContent = `${label}\nفاصله: ${d.toFixed(1)} m\nسمت: ${b.toFixed(0)}°`;
  el.classList.remove('hidden');
  if (!navLine) navLine = L.polyline([], { color: '#c3ff00', dashArray: '6,6' }).addTo(map);
  navLine.setLatLngs([[lat, lon], [target.lat, target.lon]]);
}

function onGotoUtmSubmit() {
  const zone = parseInt(document.getElementById('utm-zone').value);
  const band = (document.getElementById('utm-band').value || '').toUpperCase();
  const easting = parseFloat(document.getElementById('utm-easting').value);
  const northing = parseFloat(document.getElementById('utm-northing').value);
  if (!Number.isFinite(zone) || !Number.isFinite(easting) || !Number.isFinite(northing)) { toast('ورودی نامعتبر', 'error'); return; }
  // Build UTM projection string
  const isNorthern = band ? (band >= 'N') : true; // heuristic
  const utmProj = `+proj=utm +zone=${zone} ${isNorthern ? '+north' : '+south'} +datum=WGS84 +units=m +no_defs`;
  const inv = proj4(utmProj, 'EPSG:4326');
  const [lon, lat] = inv.inverse ? inv.inverse([easting, northing]) : inv.backward([easting, northing]);
  // Create a temp waypoint and navigate
  const temp = { lat, lon, label: `UTM ${zone}${band} ${easting} ${northing}` };
  setNavTarget(temp);
  // Not storing as permanent waypoint; draw a marker for context
  const marker = L.circleMarker([lat, lon], { radius: 6, color: '#c3ff00', weight: 2, fillColor: '#c3ff00', fillOpacity: 0.3 }).addTo(map);
  // Update overlay using current location in onPosition; also force immediate view to target
  map.setView([lat, lon], 17);
  const el = document.getElementById('nav-overlay'); if (el) { el.classList.remove('hidden'); el.textContent = `هدف UTM\n${zone}${band} ${easting} ${northing}`; }
  document.getElementById('dlg-goto').close();
}

function openWaypointsDialog() {
  document.getElementById('dlg-waypoints').showModal();
}

function closeWaypointsDialog() {
  document.getElementById('dlg-waypoints').close();
}

function openReview() {
  loadFormInfo();
  const dlg = document.getElementById('dlg-review');
  const f = formInfo;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  setVal('fi-fullname', f.fullname);
  setVal('fi-father', f.father);
  setVal('fi-nid', f.nid);
  setVal('fi-region', f.region);
  setVal('fi-parcel-main', f.parcelMain);
  setVal('fi-parcel-sub', f.parcelSub);
  // compute area/perimeter from current polygon if available
  const { areaM2, perimM } = computeFieldMetrics();
  const areaEl = document.getElementById('fi-area'); if (areaEl) areaEl.value = areaM2 ? areaM2.toFixed(2) + ' m²' : '-';
  const perEl = document.getElementById('fi-perimeter'); if (perEl) perEl.value = perimM ? perimM.toFixed(2) + ' m' : '-';
  const saveBtn = document.getElementById('fi-save'); if (saveBtn) saveBtn.onclick = saveReviewForm;
  const closeBtn = document.getElementById('close-review'); if (closeBtn) closeBtn.onclick = () => dlg.close();
  dlg.showModal();
}

function saveReviewForm() {
  const getVal = (id) => document.getElementById(id)?.value || '';
  formInfo = {
    fullname: getVal('fi-fullname'),
    father: getVal('fi-father'),
    nid: getVal('fi-nid'),
    region: getVal('fi-region'),
    parcelMain: getVal('fi-parcel-main'),
    parcelSub: getVal('fi-parcel-sub'),
  };
  saveFormInfo();
  document.getElementById('dlg-review').close();
  toast('اطلاعات ثبت شد', 'success');
}

function getPolygonLatLngs() {
  // Prefer first drawn polygon
  let pts = null;
  drawnItems.eachLayer((layer) => {
    if (!pts && layer instanceof L.Polygon) {
      const rings = layer.getLatLngs();
      const flat = Array.isArray(rings[0]) ? rings[0] : rings;
      pts = flat.map(ll => [ll.lat, ll.lng]);
    }
  });
  if (pts) return pts;
  // Fallback: use waypoints order
  if (waypoints.length >= 3) {
    return waypoints.map(w => [w.lat, w.lon]);
  }
  return null;
}

function computeFieldMetrics() {
  const pts = getPolygonLatLngs();
  if (!pts || pts.length < 3) return { areaM2: null, perimM: null };
  const poly = turf.polygon([[...pts.map(([lat,lon])=>[lon,lat]), [pts[0][1], pts[0][0]]]]);
  const areaM2 = turf.area(poly);
  // perimeter from line around
  const line = turf.lineString([...pts.map(([lat,lon])=>[lon,lat]), [pts[0][1], pts[0][0]]]);
  const perimM = turf.length(line, { units: 'kilometers' }) * 1000;
  return { areaM2, perimM };
}

function drawFieldPolygon() {
  const pts = getPolygonLatLngs();
  if (!pts) { toast('نقاط کافی برای ترسیم وجود ندارد', 'warn'); return; }
  if (fieldPolygon) { map.removeLayer(fieldPolygon); fieldPolygon = null; }
  fieldPolygon = L.polygon(pts, { color: '#39ff14', weight: 3, fillOpacity: 0.1 }).addTo(map);
  map.fitBounds(fieldPolygon.getBounds(), { padding: [20,20] });
  const { areaM2, perimM } = computeFieldMetrics();
  toast(`مساحت: ${areaM2?.toFixed(1)} m² | محیط: ${perimM?.toFixed(1)} m`, 'success');
}
async function openA4Preview() {
  await renderA4Structured();
  document.getElementById('dlg-a4').showModal();
}

async function renderA4Structured() {
  const canvas = document.getElementById('a4-canvas');
  const ctx = canvas.getContext('2d');
  // Canvas reset
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Page margins
  const margin = 50;
  const page = { x: margin, y: margin, w: canvas.width - margin*2, h: canvas.height - margin*2 };
  // Header bar
  ctx.fillStyle = '#0b1d14';
  ctx.fillRect(0, 0, canvas.width, 44);
  ctx.fillStyle = '#a6ff00';
  ctx.font = 'bold 18px Arial';
  const title = document.getElementById('a4-title')?.value || 'فرم برداشت و ترسیم زمین';
  ctx.fillText(title, margin, 30);

  // Layout regions
  const leftW = Math.floor(page.w * 0.6);
  const rightW = page.w - leftW - 10;
  const mapBox = { x: page.x, y: page.y + 10, w: leftW, h: Math.floor(page.h * 0.42) };
  const tableBox = { x: page.x, y: mapBox.y + mapBox.h + 12, w: leftW, h: Math.floor(page.h * 0.20) };
  const infoBox = { x: page.x + leftW + 10, y: page.y + 10, w: rightW, h: Math.floor(page.h * 0.32) };
  const satBox = { x: infoBox.x, y: infoBox.y + infoBox.h + 10, w: rightW, h: Math.floor(page.h * 0.28) };
  const trafBox = { x: infoBox.x, y: satBox.y + satBox.h + 10, w: rightW, h: Math.floor(page.h * 0.16) };

  // Draw frames
  const strokeFrame = (r) => { ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeRect(r.x, r.y, r.w, r.h); };
  strokeFrame(mapBox); strokeFrame(tableBox); strokeFrame(infoBox); strokeFrame(satBox); strokeFrame(trafBox);

  // Top-left: White background polygon map with edge lengths
  const pts = getPolygonLatLngs();
  if (pts && pts.length >= 3) {
    drawPolygonBox(ctx, mapBox, pts);
  } else {
    ctx.fillStyle = '#666'; ctx.font = '14px Arial'; ctx.fillText('پلیگون تعریف نشده', mapBox.x + 12, mapBox.y + 22);
  }

  // Under map: coordinate table (UTM)
  if (pts && pts.length >= 3) {
    drawCoordinateTable(ctx, tableBox, pts);
  }

  // Right: info card
  drawInfoBox(ctx, infoBox);

  // Satellite snapshot with polygon
  if (pts && pts.length >= 3) {
    const satImg = await snapshotMapWithBase('satellite', true, pts);
    if (satImg) ctx.drawImage(satImg, satBox.x + 2, satBox.y + 2, satBox.w - 4, satBox.h - 4);
  }

  // Traffic small map (OSM + traffic overlay)
  const trafImg = await snapshotMapWithBase('osm', true, pts, true);
  if (trafImg) ctx.drawImage(trafImg, trafBox.x + 2, trafBox.y + 2, trafBox.w - 4, trafBox.h - 4);

  // Footer
  ctx.fillStyle = '#0b1d14';
  ctx.fillRect(0, canvas.height - 44, canvas.width, 44);
  ctx.fillStyle = '#a6ff00'; ctx.font = '14px IBM Plex Mono, monospace';
  ctx.fillText(new Date().toLocaleString(), margin, canvas.height - 16);
}

function drawPolygonBox(ctx, box, ptsLatLon) {
  // Project to local UTM for stable scaling
  const center = ptsLatLon.reduce((s,p)=>[s[0]+p[0], s[1]+p[1]],[0,0]).map(v=>v/ptsLatLon.length);
  const { proj } = getUtmProj(center[1], center[0]);
  const xy = ptsLatLon.map(([lat,lon]) => proj.forward([lon, lat]));
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  xy.forEach(([x,y])=>{ if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; });
  const pad = 20;
  const scale = Math.min((box.w - pad*2)/(maxX-minX || 1), (box.h - pad*2)/(maxY-minY || 1));
  const toPx = ([x,y]) => [ box.x + pad + (x - minX) * scale, box.y + box.h - pad - (y - minY) * scale ];
  const px = xy.map(toPx);
  // White background
  ctx.fillStyle = '#fff'; ctx.fillRect(box.x+1, box.y+1, box.w-2, box.h-2);
  // Draw polygon
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.beginPath();
  px.forEach(([x,y],i)=>{ if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }); ctx.closePath(); ctx.stroke();
  // Vertices
  ctx.fillStyle = '#000'; px.forEach(([x,y])=>{ ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill(); });
  // Edge lengths in meters using geodesic distances
  ctx.fillStyle = '#000'; ctx.font = '12px Arial';
  for (let i=0;i<ptsLatLon.length;i++) {
    const a = ptsLatLon[i]; const b = ptsLatLon[(i+1)%ptsLatLon.length];
    const d = turf.distance([a[1],a[0]],[b[1],b[0]],{units:'meters'});
    const pa = px[i]; const pb = px[(i+1)%px.length];
    const mid = [(pa[0]+pb[0])/2, (pa[1]+pb[1])/2];
    // normal offset
    const dx = pb[0]-pa[0], dy = pb[1]-pa[1]; const len = Math.hypot(dx,dy)||1; const nx = -dy/len, ny = dx/len;
    const tx = mid[0] + nx*12; const ty = mid[1] + ny*12;
    ctx.fillText(d.toFixed(2)+' m', tx, ty);
  }
}

function drawCoordinateTable(ctx, box, ptsLatLon) {
  // Compute UTM coords
  const center = ptsLatLon.reduce((s,p)=>[s[0]+p[0], s[1]+p[1]],[0,0]).map(v=>v/ptsLatLon.length);
  const { zone, proj } = getUtmProj(center[1], center[0]);
  const rows = ptsLatLon.map(([lat,lon],i)=>{
    const [x,y] = proj.forward([lon, lat]);
    return { idx: i+1, x: x, y: y };
  });
  // Header
  ctx.fillStyle = '#f7f7f7'; ctx.fillRect(box.x, box.y, box.w, 28);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = '#000'; ctx.font = 'bold 13px Arial';
  ctx.fillText(`جدول مختصات UTM (زون ${zone})`, box.x + 8, box.y + 19);
  // Columns: Pt | X | Y
  const colIdxW = 60; const colXW = Math.floor((box.w - colIdxW)/2); const colYW = box.w - colIdxW - colXW;
  // Column headers
  const headerY = box.y + 32;
  ctx.font = 'bold 12px Arial';
  ctx.fillText('نقطه', box.x + 8, headerY);
  ctx.fillText('X', box.x + colIdxW + 8, headerY);
  ctx.fillText('Y', box.x + colIdxW + colXW + 8, headerY);
  // Rows
  ctx.font = '12px IBM Plex Mono, monospace';
  const rowH = 22; let y = headerY + 8;
  rows.forEach(r=>{
    if (y + rowH > box.y + box.h) return; // stop overflow
    ctx.fillStyle = '#000';
    ctx.fillText(String(r.idx), box.x + 8, y + 14);
    ctx.fillText(Math.round(r.x).toString(), box.x + colIdxW + 8, y + 14);
    ctx.fillText(Math.round(r.y).toString(), box.x + colIdxW + colXW + 8, y + 14);
    // optional row separators
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.beginPath(); ctx.moveTo(box.x, y + rowH); ctx.lineTo(box.x + box.w, y + rowH); ctx.stroke();
    y += rowH;
  });
}

function drawInfoBox(ctx, box) {
  const { areaM2 } = computeFieldMetrics();
  const lines = [
    ['نام و نام خانوادگی', formInfo.fullname || '-'],
    ['نام پدر', formInfo.father || '-'],
    ['کد ملی', formInfo.nid || '-'],
    ['منطقه', formInfo.region || '-'],
    ['پلاک اصلی', formInfo.parcelMain || '-'],
    ['پلاک فرعی', formInfo.parcelSub || '-'],
    ['مساحت (متر مربع)', areaM2 ? areaM2.toFixed(2) : '-'],
  ];
  ctx.fillStyle = '#f7f7f7'; ctx.fillRect(box.x+1, box.y+1, box.w-2, box.h-2);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = '#000'; ctx.font = 'bold 13px Arial'; ctx.fillText('اطلاعات نقشه', box.x + 8, box.y + 20);
  let y = box.y + 34; const rowH = 24;
  ctx.font = '12px Arial';
  lines.forEach(([k,v])=>{
    if (y + rowH > box.y + box.h) return;
    ctx.fillStyle = '#333'; ctx.fillText(k + ':', box.x + 8, y + 14);
    ctx.fillStyle = '#000'; ctx.fillText(v, box.x + 140, y + 14);
    y += rowH;
  });
}

async function snapshotMapWithBase(baseKey, includePolygon, ptsLatLon, includeTraffic=false) {
  const prevBase = currentBaseKey;
  const trafficWasOn = trafficLayer && map.hasLayer(trafficLayer);
  // Temp polygon layer
  let tempPoly = null;
  try {
    setBaseLayer(baseKey);
    if (includeTraffic && trafficLayer) trafficLayer.addTo(map);
    if (!includeTraffic && trafficLayer && map.hasLayer(trafficLayer)) map.removeLayer(trafficLayer);
    if (includePolygon && ptsLatLon && ptsLatLon.length>=3) {
      tempPoly = L.polygon(ptsLatLon, { color: '#ff3b30', weight: 2, fillOpacity: 0.1 }).addTo(map);
    }
    const img = await new Promise((resolve) => {
      leafletImage(map, function(err, mapCanvas) { if (err) resolve(null); else resolve(mapCanvas); });
    });
    return img;
  } finally {
    if (tempPoly) map.removeLayer(tempPoly);
    if (trafficWasOn) { if (trafficLayer && !map.hasLayer(trafficLayer)) trafficLayer.addTo(map); }
    else { if (trafficLayer && map.hasLayer(trafficLayer)) map.removeLayer(trafficLayer); }
    setBaseLayer(prevBase);
  }
}

function drawNorthArrow(ctx, x, y) {
  ctx.save();
  ctx.fillStyle = '#a6ff00';
  ctx.beginPath();
  ctx.moveTo(x, y - 30); ctx.lineTo(x - 10, y + 10); ctx.lineTo(x + 10, y + 10); ctx.closePath();
  ctx.fill();
  ctx.font = 'bold 12px Arial';
  ctx.fillText('N', x - 6, y + 24);
  ctx.restore();
}

function drawScaleBar(ctx, x, y, width) {
  // Estimate meters per pixel using Leaflet CRS helpers
  const centerLat = map.getCenter().lat;
  const metersPerPixel = 156543.03392 * Math.cos(centerLat * Math.PI / 180) / Math.pow(2, map.getZoom());
  let targetMeters = 100; // start at 100 m
  const maxPx = Math.min(200, width * 0.25);
  while ((targetMeters / metersPerPixel) > maxPx) targetMeters /= 2;
  while ((targetMeters / metersPerPixel) < (maxPx / 2)) targetMeters *= 2;
  const px = targetMeters / metersPerPixel;
  ctx.save();
  ctx.strokeStyle = '#0b1d14'; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.stroke();
  ctx.strokeStyle = '#a6ff00'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.stroke();
  ctx.fillStyle = '#0b1d14'; ctx.fillRect(x, y - 10, 2, 20); ctx.fillRect(x + px - 2, y - 10, 2, 20);
  ctx.fillStyle = '#a6ff00'; ctx.font = '14px IBM Plex Mono, monospace'; ctx.fillText(`${Math.round(targetMeters)} m`, x + 6, y - 8);
  ctx.restore();
}

function downloadA4Png() {
  const canvas = document.getElementById('a4-canvas');
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = 'map-a4.png'; a.click();
}

function downloadA4Jpg() {
  const canvas = document.getElementById('a4-canvas');
  const url = canvas.toDataURL('image/jpeg', 0.92);
  const a = document.createElement('a');
  a.href = url; a.download = 'map-a4.jpg'; a.click();
}

function downloadA4Pdf() {
  const canvas = document.getElementById('a4-canvas');
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) { toast('PDF در دسترس نیست', 'error'); return; }
  const pdf = new jsPDF('p', 'pt', [canvas.width, canvas.height]);
  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, canvas.width, canvas.height);
  pdf.save('map-a4.pdf');
}

function initUI() {
  // Motion/compass permission (Android Chrome requires user gesture)
  const btnCompass = document.getElementById('btn-compass-perm');
  if (btnCompass) {
    btnCompass.onclick = async () => {
      try {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res !== 'granted') return;
        }
        window.addEventListener('deviceorientationabsolute', onOrientation, true);
        window.addEventListener('deviceorientation', onOrientation, true);
      } catch (e) { console.warn(e); }
    };
  }
  document.getElementById('btn-mark').onclick = addWaypointFromCurrent;
  document.getElementById('btn-draw').onclick = () => {
    // Toggle draw polyline as default
    new L.Draw.Polyline(map, draw.options.draw.polyline).enable();
  };
  document.getElementById('btn-waypoints').onclick = () => { openWaypointsDialog(); };
  document.getElementById('btn-print').onclick = openA4Preview;
  const btnReview = document.getElementById('btn-review'); if (btnReview) btnReview.onclick = openReview;
  const btnPlot = document.getElementById('btn-plot'); if (btnPlot) btnPlot.onclick = drawFieldPolygon;
  document.getElementById('download-image').onclick = downloadA4Png;
  const btnPdf = document.getElementById('download-pdf'); if (btnPdf) btnPdf.onclick = downloadA4Pdf;
  document.getElementById('close-waypoints').onclick = closeWaypointsDialog;
  document.getElementById('close-a4').onclick = () => document.getElementById('dlg-a4').close();

  document.getElementById('export-gpx').onclick = exportGPX;
  document.getElementById('export-kml').onclick = exportKML;
  const btnDXF = document.getElementById('export-dxf'); if (btnDXF) btnDXF.onclick = exportDXF;
  const btnDXFDraw = document.getElementById('export-dxf-drawings'); if (btnDXFDraw) btnDXFDraw.onclick = exportDXFDrawings;
  // DXF UTM zone shortcuts
  const d39 = document.getElementById('dxf-utm-39'); if (d39) d39.onclick = () => { exportDXFDrawings(39); };
  const d40 = document.getElementById('dxf-utm-40'); if (d40) d40.onclick = () => { exportDXFDrawings(40); };
  const dCus = document.getElementById('dxf-utm-custom'); if (dCus) dCus.addEventListener('change', () => { const z = parseInt(dCus.value); if (Number.isFinite(z)) exportDXFDrawings(z); });
  const btnShare = document.getElementById('share-files'); if (btnShare) btnShare.onclick = shareFilesIfSupported;
  const btnImport = document.getElementById('import-data'); const inputImport = document.getElementById('import-file');
  if (btnImport && inputImport) { btnImport.onclick = () => inputImport.click(); inputImport.onchange = onImportFile; }

  window.addEventListener('online', setOnlineStatus);
  window.addEventListener('offline', setOnlineStatus);
  setOnlineStatus();

  // Layer selector and traffic toggle
  const layerSelect = document.getElementById('layer-select');
  if (layerSelect) {
    // Restore saved base layer
    try {
      const savedBase = localStorage.getItem(UI_LAYER_KEY);
      if (savedBase && baseLayers[savedBase]) { currentBaseKey = savedBase; setBaseLayer(savedBase); }
      layerSelect.value = currentBaseKey;
    } catch {}
    layerSelect.onchange = () => {
      setBaseLayer(layerSelect.value);
    };
  }
  const trafficToggle = document.getElementById('traffic-toggle');
  if (trafficToggle) {
    // Restore saved traffic
    try {
      const saved = localStorage.getItem(UI_TRAFFIC_KEY);
      const on = saved === '1';
      trafficToggle.checked = on;
      if (on) trafficLayer.addTo(map);
    } catch {}
    trafficToggle.onchange = () => {
      if (trafficToggle.checked) {
        trafficLayer.addTo(map);
      } else {
        if (trafficLayer && map.hasLayer(trafficLayer)) map.removeLayer(trafficLayer);
      }
      try { localStorage.setItem(UI_TRAFFIC_KEY, trafficToggle.checked ? '1' : '0'); } catch {}
    };
  }

  // Quick Menu
  const dlgMenu = document.getElementById('dlg-menu');
  const btnMenu = document.getElementById('btn-quick-menu');
  const closeMenu = document.getElementById('close-menu');
  if (btnMenu) btnMenu.onclick = () => dlgMenu.showModal();
  if (closeMenu) closeMenu.onclick = () => dlgMenu.close();

  // Offline toggle
  const toggle = document.getElementById('toggle-offline');
  if (toggle) toggle.onclick = () => {
    useOffline = !useOffline;
    toggle.textContent = useOffline ? 'آنلاین' : 'حالت آفلاین';
    if (useOffline && offlineLayer) {
      offlineLayer.addTo(map);
    } else if (offlineLayer) {
      map.removeLayer(offlineLayer);
    }
  };

  // MBTiles input
  const fileInput = document.getElementById('mbtiles-input');
  if (fileInput) fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await ensureSqlLoaded();
    const buf = await file.arrayBuffer();
    mbtilesDb = new SQL.Database(new Uint8Array(buf));
    offlineLayer = createMbtilesLayer(mbtilesDb);
    if (useOffline) offlineLayer.addTo(map);
  };

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(console.warn);
  }
  // Track toggle
  const btnTrack = document.getElementById('toggle-track');
  if (btnTrack) btnTrack.onclick = () => { trackingEnabled = !trackingEnabled; btnTrack.textContent = trackingEnabled ? 'ثبت مسیر' : 'توقف مسیر'; toast(trackingEnabled ? 'ثبت مسیر فعال' : 'ثبت مسیر متوقف شد', 'success'); };
  // Follow toggle
  const btnFollow = document.getElementById('toggle-follow');
  if (btnFollow) btnFollow.onclick = () => { followMode = !followMode; btnFollow.textContent = followMode ? 'خاموش کردن دنبال' : 'دنبال نقشه'; };
  // Clear navigation
  const btnClearNav = document.getElementById('clear-nav');
  if (btnClearNav) btnClearNav.onclick = () => { setNavTarget(null); toast('ناوبری لغو شد', 'success'); };

  // Arrow mode fullscreen
  const btnArrow = document.getElementById('btn-arrow-mode');
  const navFull = document.getElementById('nav-full');
  const closeNavFull = document.getElementById('close-nav-full');
  if (btnArrow) btnArrow.onclick = () => { navFull.classList.remove('hidden'); };
  if (closeNavFull) closeNavFull.onclick = () => { navFull.classList.add('hidden'); };

  // Info panel collapse persist
  const info = document.getElementById('info-panel');
  const tInfo = document.getElementById('toggle-info');
  const INFO_KEY = 'fieldgps.ui.info.collapsed';
  const collapsed = localStorage.getItem(INFO_KEY) === '1';
  if (collapsed) info.classList.add('hidden');
  if (tInfo) tInfo.onclick = () => { info.classList.toggle('hidden'); localStorage.setItem(INFO_KEY, info.classList.contains('hidden') ? '1' : '0'); };

  // Go to UTM modal
  const btnGoto = document.getElementById('btn-goto-utm');
  const dlgGoto = document.getElementById('dlg-goto');
  const closeGoto = document.getElementById('close-goto');
  const gotoSubmit = document.getElementById('goto-submit');
  if (btnGoto) btnGoto.onclick = () => dlgGoto.showModal();
  if (closeGoto) closeGoto.onclick = () => dlgGoto.close();
  if (gotoSubmit) gotoSubmit.onclick = onGotoUtmSubmit;
  const q39 = document.getElementById('utm-quick-39'); if (q39) q39.onclick = () => { document.getElementById('utm-zone').value = 39; };
  const q40 = document.getElementById('utm-quick-40'); if (q40) q40.onclick = () => { document.getElementById('utm-zone').value = 40; };

  // Mark averaging modal
  const dlgMark = document.getElementById('dlg-mark');
  const closeMark = document.getElementById('close-mark'); if (closeMark) closeMark.onclick = () => dlgMark.close();
  const btnMark = document.getElementById('btn-mark'); if (btnMark) btnMark.onclick = () => { dlgMark.showModal(); resetAveraging(); };
  const avgStart = document.getElementById('avg-start'); if (avgStart) avgStart.onclick = startAveraging;
  const avgStop = document.getElementById('avg-stop'); if (avgStop) avgStop.onclick = stopAveraging;
  const avgSave = document.getElementById('avg-save'); if (avgSave) avgSave.onclick = saveAveragedPoint;

  // Logging CSV toggle
  const btnLog = document.getElementById('btn-log');
  if (btnLog) btnLog.onclick = () => { loggingCsv.active = !loggingCsv.active; btnLog.textContent = loggingCsv.active ? 'توقف CSV' : 'ثبت CSV'; if (loggingCsv.active) loggingCsv.rows = ['time,lat,lon,alt,acc,speed']; };

  // GNSS (Web Serial) button
  const btnGnss = document.getElementById('btn-gnss'); if (btnGnss) btnGnss.onclick = connectGnss;

  // Ripple effect delegation for all .btn
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('.btn');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.left = x + 'px';
    span.style.top = y + 'px';
    target.appendChild(span);
    setTimeout(() => span.remove(), 650);
  }, true);
  // Settings modal
  const settingsBtn = document.getElementById('btn-settings');
  const dlgSettings = document.getElementById('dlg-settings');
  const closeSettings = document.getElementById('close-settings');
  const inputAcc = document.getElementById('set-max-acc');
  const valAcc = document.getElementById('set-max-acc-val');
  const inputRad = document.getElementById('set-alert-radius');
  const valRad = document.getElementById('set-alert-radius-val');
  const saveSettings = document.getElementById('save-settings');
  loadSettings();
  updateSettingsUI();
  if (settingsBtn) settingsBtn.onclick = () => dlgSettings.showModal();
  if (closeSettings) closeSettings.onclick = () => dlgSettings.close();
  function updateSettingsUI() {
    inputAcc.value = settings.maxAccM; valAcc.textContent = settings.maxAccM + ' m';
    inputRad.value = settings.alertRadiusM; valRad.textContent = settings.alertRadiusM + ' m';
  }
  function readSettingsUI() {
    settings.maxAccM = parseInt(inputAcc.value);
    settings.alertRadiusM = parseInt(inputRad.value);
  }
  inputAcc.oninput = () => { valAcc.textContent = inputAcc.value + ' m'; };
  inputRad.oninput = () => { valRad.textContent = inputRad.value + ' m'; };
  saveSettings.onclick = () => { readSettingsUI(); saveSettingsLocal(); dlgSettings.close(); toast('ذخیره شد', 'success'); };

  // Quick measure via long press
  let pressTimer = null, pressStartLatLng = null, measureLine = null;
  map.on('mousedown touchstart', (e) => {
    pressStartLatLng = e.latlng;
    pressTimer = setTimeout(() => {
      if (!pressStartLatLng) return;
      if (measureLine) map.removeLayer(measureLine);
      measureLine = L.polyline([pressStartLatLng], { color: '#a6ff00', dashArray: '4,6' }).addTo(map);
      toast('اندازه‌گیری سریع: نقطه دوم را لمس کنید', 'warn');
      const move = (ev) => { if (measureLine) measureLine.setLatLngs([pressStartLatLng, ev.latlng]); };
      const end = (ev) => {
        map.off('mousemove', move); map.off('touchmove', move); map.off('mouseup', end); map.off('touchend', end);
        if (measureLine) {
          const pts = measureLine.getLatLngs();
          if (pts.length >= 2) {
            const line = turf.lineString(pts.map(ll => [ll.lng, ll.lat]));
            const m = turf.length(line, { units: 'kilometers' }) * 1000;
            toast(`طول: ${m.toFixed(1)} m`, 'success');
          }
          setTimeout(() => { map.removeLayer(measureLine); measureLine = null; }, 800);
        }
      };
      map.on('mousemove', move); map.on('touchmove', move); map.on('mouseup', end); map.on('touchend', end);
    }, 550);
  });
  map.on('mouseup touchend', () => { clearTimeout(pressTimer); pressTimer = null; pressStartLatLng = null; });
}

window.addEventListener('load', () => {
  initMap();
  initUI();
  loadWaypoints();
  requestHighAccuracyPosition();
  generateIconsAndSwapManifest();
});

async function ensureSqlLoaded() {
  if (SQL) return SQL;
  SQL = await window.initSqlJs({ locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${file}` });
  return SQL;
}

function createMbtilesLayer(db) {
  const stmt = db.prepare('SELECT value FROM metadata WHERE name = ?');
  let minzoom = 0, maxzoom = 14;
  try {
    stmt.bind(['minzoom']); if (stmt.step()) minzoom = parseInt(stmt.get()[0]); stmt.reset();
    stmt.bind(['maxzoom']); if (stmt.step()) maxzoom = parseInt(stmt.get()[0]);
  } catch {}
  stmt.free();

  const layer = L.gridLayer({ minZoom: minzoom, maxZoom: maxzoom });
  layer.createTile = function(coords) {
    const tile = document.createElement('img');
    tile.alt = '';
    const png = getTilePng(db, coords.z, coords.x, coords.y);
    if (png) {
      const blob = new Blob([png], { type: 'image/png' });
      tile.src = URL.createObjectURL(blob);
    } else {
      // empty tile
      tile.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ctQ3O0AAAAASUVORK5CYII=';
    }
    return tile;
  };
  return layer;
}

function tmsToZxyY(z, x, yTms) {
  const y = Math.pow(2, z) - 1 - yTms; // TMS → XYZ
  return { z, x, y };
}

function getTilePng(db, z, x, y) {
  // MBTiles stores TMS y
  const yTms = Math.pow(2, z) - 1 - y;
  const stmt = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?');
  stmt.bind([z, x, yTms]);
  let data = null;
  if (stmt.step()) {
    const val = stmt.getAsObject().tile_data; // Uint8Array
    data = val;
  }
  stmt.free();
  return data;
}

function loadSettings() {
  try { const s = localStorage.getItem(SETTINGS_KEY); if (s) settings = JSON.parse(s); } catch {}
}
function saveSettingsLocal() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function renderSparkline() {
  const c = document.getElementById('sparkline'); if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  // Draw speed (green) and altitude (yellow-green)
  drawSeries(ctx, speedHistory, '#00d46a');
  drawSeries(ctx, normalizeSeries(altHistory), '#c3ff00');
  renderSatSNR();
}

function drawSeries(ctx, series, color) {
  if (!series.length) return;
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const dx = series.length > 1 ? (w / (series.length - 1)) : w;
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  series.forEach((v, i) => {
    const x = i * dx;
    const t = max === min ? 0.5 : (v - min) / (max - min);
    const y = h - t * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function normalizeSeries(series) {
  if (!series.length) return series;
  const max = Math.max(...series), min = Math.min(...series);
  if (max === min) return series.map(() => 0.5);
  return series.map(v => (v - min) / (max - min));
}

function checkProximityAlerts(lat, lon) {
  if (!waypoints.length) return;
  let nearest = null; let nearestD = Infinity;
  for (const w of waypoints) {
    const d = turf.distance([lon, lat], [w.lon, w.lat], { units: 'meters' });
    if (d < nearestD) { nearest = w; nearestD = d; }
  }
  if (nearest && nearestD <= settings.alertRadiusM) {
    toast(`نزدیک نقطه ${nearest.id} — ${nearestD.toFixed(1)} m`, 'warn');
  }
}

function toast(message, type = 'success') {
  const box = document.getElementById('toasts'); if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; setTimeout(() => el.remove(), 250); }, 2200);
}

// Generate PNG icons and swap manifest + apple-touch-icon at runtime
async function generateIconsAndSwapManifest() {
  try {
    const icon512 = await drawIconPng(512);
    const icon192 = await drawIconPng(192);

    // Swap manifest
    const manifest = {
      name: 'جی‌پی‌اس میدانی',
      short_name: 'GPS Field',
      start_url: '.',
      display: 'standalone',
      background_color: '#0B1D14',
      theme_color: '#0B1D14',
      dir: 'rtl',
      lang: 'fa',
      icons: [
        { src: icon192, sizes: '192x192', type: 'image/png' },
        { src: icon512, sizes: '512x512', type: 'image/png' },
      ]
    };
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    link.href = URL.createObjectURL(blob);

    // Apple touch icon
    let apple = document.querySelector('link[rel="apple-touch-icon"]');
    if (!apple) {
      apple = document.createElement('link');
      apple.rel = 'apple-touch-icon';
      document.head.appendChild(apple);
    }
    apple.href = icon192;
  } catch (e) { console.warn('icon gen failed', e); }
}

function drawIconPng(size) {
  return new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    // background gradient
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, '#0B1D14');
    g.addColorStop(1, '#0a110d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // rounded mask
    const radius = size * 0.12;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, size, size, radius);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // ring
    ctx.strokeStyle = '#556B2F';
    ctx.lineWidth = Math.max(6, size * 0.03);
    ctx.beginPath();
    ctx.arc(size/2, size/2, size*0.35, 0, Math.PI*2);
    ctx.stroke();
    // crosshairs
    ctx.strokeStyle = '#A6FF00';
    ctx.lineWidth = Math.max(8, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(size/2, size*0.18); ctx.lineTo(size/2, size*0.34);
    ctx.moveTo(size/2, size*0.66); ctx.lineTo(size/2, size*0.82);
    ctx.moveTo(size*0.18, size/2); ctx.lineTo(size*0.34, size/2);
    ctx.moveTo(size*0.66, size/2); ctx.lineTo(size*0.82, size/2);
    ctx.stroke();
    // center dot
    ctx.fillStyle = '#A6FF00';
    ctx.beginPath(); ctx.arc(size/2, size/2, Math.max(3, size*0.012), 0, Math.PI*2); ctx.fill();
    // text GPS
    ctx.fillStyle = '#C3FF00';
    ctx.font = `bold ${Math.floor(size*0.16)}px Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('GPS', size/2, size*0.92);
    resolve(c.toDataURL('image/png'));
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}

// Device orientation to update compass heading when GPS heading is absent
function onOrientation(ev) {
  let deg = null;
  if (ev.absolute && typeof ev.alpha === 'number') deg = 360 - ev.alpha; // alpha: 0 = north
  else if (typeof ev.webkitCompassHeading === 'number') deg = ev.webkitCompassHeading; // iOS
  if (deg != null && !Number.isNaN(deg)) setHeading((deg + 360) % 360);
}

// Haptics and beep
function hapticBeep() {
  try { if (navigator.vibrate) navigator.vibrate(50); } catch {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 1000;
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 120);
  } catch {}
}

// Averaging helpers
function resetAveraging() { averaging = { active: false, samples: [] }; updateAveragingUI(); }
function startAveraging() { averaging.active = true; averaging.samples = []; updateAveragingUI(); }
function stopAveraging() { averaging.active = false; updateAveragingUI(); }
function updateAveragingUI() {
  const c = document.getElementById('avg-count'); const a = document.getElementById('avg-acc'); const u = document.getElementById('avg-utm'); const ll = document.getElementById('avg-latlon');
  if (!c) return;
  c.textContent = String(averaging.samples.length);
  if (!averaging.samples.length) { a.textContent = '—'; u.textContent = '—'; ll.textContent = '—'; return; }
  const avgLat = averaging.samples.reduce((s,p)=>s+p.lat,0)/averaging.samples.length;
  const avgLon = averaging.samples.reduce((s,p)=>s+p.lon,0)/averaging.samples.length;
  const accs = averaging.samples.map(p=>p.acc).filter(v=>v!=null);
  const avgAcc = accs.length ? (accs.reduce((s,v)=>s+v,0)/accs.length) : null;
  a.textContent = avgAcc!=null ? avgAcc.toFixed(1) : '—';
  const utm = toUtm(avgLat, avgLon);
  u.textContent = `${utm.zone}${utm.band} ${utm.easting} ${utm.northing}`;
  ll.textContent = `${avgLat.toFixed(6)}, ${avgLon.toFixed(6)}`;
}
function saveAveragedPoint() {
  if (!averaging.samples.length) { toast('نمونه‌ای وجود ندارد', 'error'); return; }
  const avgLat = averaging.samples.reduce((s,p)=>s+p.lat,0)/averaging.samples.length;
  const avgLon = averaging.samples.reduce((s,p)=>s+p.lon,0)/averaging.samples.length;
  const type = document.getElementById('mark-type')?.value || 'Point';
  const note = document.getElementById('mark-note')?.value || '';
  const utm = toUtm(avgLat, avgLon);
  const wp = { id: `AVG-${Date.now()}`, lat: avgLat, lon: avgLon, altitudeM: null, accuracyM: null, utmZone: utm.zone, utmBand: utm.band, easting: utm.easting, northing: utm.northing, timestamp: new Date().toISOString(), type, note };
  waypoints.push(wp); saveWaypoints(); L.circleMarker([wp.lat, wp.lon], { radius: 5, color: '#ff3b30', weight: 2, fillColor: '#ff3b30', fillOpacity: 0.6 }).addTo(map); renderWaypointList();
  document.getElementById('dlg-mark').close(); toast('نقطه ذخیره شد', 'success');
}

// Download CSV log
function downloadCsvLog() {
  if (!loggingCsv.rows.length) { toast('داده‌ای ثبت نشده', 'warn'); return; }
  downloadText('log.csv', loggingCsv.rows.join('\n'), 'text/csv');
}

async function connectGnss() {
  try {
    if (!('serial' in navigator)) { toast('مرورگر از Web Serial پشتیبانی نمی‌کند', 'error'); return; }
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    nmea.device = port; nmea.connected = true; updateSatBadge();
    const decoder = new TextDecoderStream();
    const readableStreamClosed = port.readable.pipeTo(decoder.writable);
    const inputStream = decoder.readable;
    nmea.reader = inputStream.getReader();
    let buffer = '';
    (async () => {
      while (true) {
        const { value, done } = await nmea.reader.read();
        if (done) break;
        buffer += value;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx+1);
          if (line.startsWith('$')) handleNmeaSentence(line);
        }
      }
    })();
    toast('GNSS متصل شد', 'success');
  } catch (e) { console.warn(e); toast('اتصال GNSS ناموفق', 'error'); }
}

function handleNmeaSentence(s) {
  // Basic GSV parsing for satellites and SNR
  const parts = s.split(',');
  if (s.includes('GSV')) {
    const totalMsgs = parseInt(parts[1]);
    const msgNum = parseInt(parts[2]);
    const totalSats = parseInt(parts[3]);
    if (msgNum === 1) nmea.sats = [];
    for (let i = 4; i + 3 < parts.length; i += 4) {
      const prn = parts[i];
      const elev = parseInt(parts[i+1]);
      const az = parseInt(parts[i+2]);
      const snr = parseInt(parts[i+3]);
      if (prn) nmea.sats.push({ prn, elev, az, snr: Number.isFinite(snr) ? snr : 0 });
    }
    updateSatBadge();
    renderSatSNR();
  }
}

function renderSatSNR() {
  const c = document.getElementById('sat-snr'); if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  const sats = (nmea.sats || []).slice(0, 12);
  const w = c.width, h = c.height; const barW = Math.max(14, (w - 20) / Math.max(12, sats.length+1));
  ctx.fillStyle = '#98b18d'; ctx.font = '10px IBM Plex Mono, monospace';
  sats.forEach((sat, idx) => {
    const x = 10 + idx * barW;
    const snr = Math.max(0, Math.min(60, sat.snr || 0));
    const bh = (snr / 60) * (h - 24);
    ctx.fillStyle = snr >= 35 ? '#00d46a' : snr >= 20 ? '#c3ff00' : '#ff3b30';
    ctx.fillRect(x, h - 12 - bh, barW - 6, bh);
    ctx.fillStyle = '#98b18d';
    ctx.fillText(String(sat.prn), x, h - 2);
  });
}

