/* Military GPS Web App for GitHub Pages */

// Map style: dark military (MapLibre-compatible raster tiles from Carto/OSM alternatives)
// We will use Esri Satellite + OSM dark as examples with proper attribution.

let map, draw, drawnItems, trailLine, accuracyCircle;
let watchId = null;
let lastPosition = null;
let trackCoords = [];
let waypoints = [];
const WAYPOINTS_KEY = 'fieldgps.waypoints.v1';
let useOffline = false;
let offlineLayer = null;
let SQL = null;
let mbtilesDb = null;

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

  // Base layers
  const cartoDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    attribution: '© OpenStreetMap, © CARTO',
    crossOrigin: true,
  });
  cartoDark.addTo(map);

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
  if (trackCoords.length === 1) {
    map.setView([latitude, longitude], 17);
  }

  setGpsStatus(true);
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

function setGpsStatus(ok) {
  const el = document.getElementById('gps-status');
  el.textContent = ok ? 'GPS' : 'GPS?';
  el.classList.toggle('offline', !ok);
  el.classList.toggle('online', ok);
}

function setOnlineStatus() {
  const el = document.getElementById('online-status');
  const online = navigator.onLine;
  el.textContent = online ? 'ONLINE' : 'OFFLINE';
  el.classList.toggle('online', online);
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
  const xml = `${header}${pts}${line}</Document></kml>`;
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

async function shareFilesIfSupported() {
  if (!('canShare' in navigator) || !('share' in navigator)) return;
  // Prepare a small GPX Blob as example
  const header = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="FieldGPS" xmlns="http://www.topografix.com/GPX/1/1">`;
  const pts = waypoints.map(w => `<wpt lat=\"${w.lat}\" lon=\"${w.lon}\"><time>${w.timestamp}</time><name>${w.id}</name></wpt>`).join('');
  const xml = `${header}${pts}</gpx>`;
  const file = new File([xml], 'points.gpx', { type: 'application/gpx+xml' });
  if (navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: 'Field GPS', text: 'Waypoints' });
  }
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function openWaypointsDialog() {
  document.getElementById('dlg-waypoints').showModal();
}

function closeWaypointsDialog() {
  document.getElementById('dlg-waypoints').close();
}

function openA4Preview() {
  // Render Leaflet snapshot then write to an A4 canvas with decorations
  const canvas = document.getElementById('a4-canvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  leafletImage(map, function(err, mapCanvas) {
    if (err) { console.error(err); return; }
    // Fit map image into A4 with margins
    const margin = 60;
    const targetW = canvas.width - margin * 2;
    const targetH = canvas.height - margin * 2 - 140; // space for footer
    const scale = Math.min(targetW / mapCanvas.width, targetH / mapCanvas.height);
    const drawW = Math.floor(mapCanvas.width * scale);
    const drawH = Math.floor(mapCanvas.height * scale);
    const dx = Math.floor((canvas.width - drawW) / 2);
    const dy = margin;

    ctx.drawImage(mapCanvas, dx, dy, drawW, drawH);

    // Header
    ctx.fillStyle = '#0b1d14';
    ctx.fillRect(0, 0, canvas.width, 48);
    ctx.fillStyle = '#a6ff00';
    ctx.font = 'bold 20px Barlow, Arial';
    ctx.fillText('FIELD GPS — A4 Map Sheet', margin, 32);

    // Footer info: UTM/LatLon/time
    ctx.fillStyle = '#0b1d14';
    ctx.fillRect(0, canvas.height - 100, canvas.width, 100);
    ctx.fillStyle = '#a6ff00';
    ctx.font = '16px IBM Plex Mono, monospace';
    if (lastPosition) {
      const { latitude, longitude } = lastPosition.coords;
      const utm = toUtm(latitude, longitude);
      ctx.fillText(`Center: UTM ${utm.zone}${utm.band} ${utm.easting} ${utm.northing}`, margin, canvas.height - 64);
      ctx.fillText(`Center: Lat/Lon ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`, margin, canvas.height - 40);
    }
    ctx.fillText(`Generated: ${new Date().toLocaleString()}`, margin, canvas.height - 16);

    // Simple north arrow
    drawNorthArrow(ctx, canvas.width - margin - 40, canvas.height - 60);

    // Scale bar (approx, based on current zoom metersPerPixel)
    drawScaleBar(ctx, dx, dy + drawH + 16, drawW);

    document.getElementById('dlg-a4').showModal();
  });
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
  document.getElementById('download-image').onclick = downloadA4Png;
  document.getElementById('close-waypoints').onclick = closeWaypointsDialog;
  document.getElementById('close-a4').onclick = () => document.getElementById('dlg-a4').close();

  document.getElementById('export-gpx').onclick = exportGPX;
  document.getElementById('export-kml').onclick = exportKML;
  const btnDXF = document.getElementById('export-dxf'); if (btnDXF) btnDXF.onclick = exportDXF;
  const btnShare = document.getElementById('share-files'); if (btnShare) btnShare.onclick = shareFilesIfSupported;

  window.addEventListener('online', setOnlineStatus);
  window.addEventListener('offline', setOnlineStatus);
  setOnlineStatus();

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

