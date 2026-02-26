'use strict';

// ─── Globals ──────────────────────────────────────────────────────────────
let db = null;
let SQL = null;
let currentProjectId = null;
let complianceChart = null;
let ganttProyecto = null;
let ganttDashboard = null;
let editingProjectId = null;
let editingActivityId = null;
let editingMacroproyectoId = null;
let copyingActivityId = null;
let selectedActivityIds = new Set();
let dashboardFiltroMacro = '';
let activitiesSortable = null;

// ─── Utils ────────────────────────────────────────────────────────────────
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function fmtDate(s) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function rows(res) {
  if (!res || !res.length) return [];
  const cols = res[0].columns;
  return res[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

function scalar(res) {
  return res && res.length ? res[0].values[0][0] : null;
}

function mostrarToast(mensaje) {
  alert(mensaje);
}

// ─── Persistencia con localStorage ────────────────────────────────────────
function guardarBDenLocalStorage() {
  if (!db) return;
  const data = db.export();
  const base64 = btoa(String.fromCharCode.apply(null, data));
  localStorage.setItem('proyectosDB', base64);
}

function cargarBDdeLocalStorage() {
  const base64 = localStorage.getItem('proyectosDB');
  if (!base64) return null;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new SQL.Database(bytes);
  } catch (e) {
    console.error('Error al cargar BD desde localStorage', e);
    return null;
  }
}

// ─── Gestión de estado de macroproyectos colapsados ───────────────────────
function getMacroCollapseState() {
  try {
    const stored = localStorage.getItem('macroCollapseState');
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    return {};
  }
}

function setMacroCollapseState(macroId, collapsed) {
  try {
    const state = getMacroCollapseState();
    state[macroId] = collapsed;
    localStorage.setItem('macroCollapseState', JSON.stringify(state));
  } catch (e) {
    console.error('Error al guardar estado de colapso', e);
  }
}

// ─── DB ───────────────────────────────────────────────────────────────────
function migrateDB() {
  try { db.run("ALTER TABLE actividades ADD COLUMN porcentaje INTEGER DEFAULT 0"); } catch (e) { }
  try { db.run("ALTER TABLE actividades ADD COLUMN comentario TEXT DEFAULT ''"); } catch (e) { }
  try {
    db.run(`CREATE TABLE IF NOT EXISTS macroproyectos (
      id TEXT PRIMARY KEY, nombre TEXT NOT NULL, descripcion TEXT DEFAULT ''
    )`);
  } catch (e) { }
  try { db.run("ALTER TABLE proyectos ADD COLUMN macroproyectoId TEXT"); } catch (e) { }
  
  // Migración: agregar columna orden
  try { 
    db.run("ALTER TABLE actividades ADD COLUMN orden INTEGER DEFAULT 0"); 
    const proyectos = rows(db.exec("SELECT id FROM proyectos"));
    proyectos.forEach(p => {
      const acts = rows(db.exec("SELECT * FROM actividades WHERE proyectoId=? ORDER BY fechaInicio", [p.id]));
      const raices = acts.filter(a => !a.padre).sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));
      const hijos = acts.filter(a => a.padre);
      let orden = 1;
      
      raices.forEach(r => {
        db.run("UPDATE actividades SET orden=? WHERE id=?", [orden++, r.id]);
        const hijosDeR = hijos.filter(h => h.padre === r.id).sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));
        hijosDeR.forEach(h => {
          db.run("UPDATE actividades SET orden=? WHERE id=?", [orden++, h.id]);
        });
      });
      
      hijos.filter(h => !raices.find(r => r.id === h.padre)).forEach(h => {
        db.run("UPDATE actividades SET orden=? WHERE id=?", [orden++, h.id]);
      });
    });
  } catch (e) { }
}

async function initDB() {
  SQL = await initSqlJs({
    locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`
  });

  const savedDB = cargarBDdeLocalStorage();
  if (savedDB) {
    db = savedDB;
    migrateDB();
  } else {
    db = new SQL.Database();
    db.run(`
      CREATE TABLE IF NOT EXISTS macroproyectos (
        id TEXT PRIMARY KEY, nombre TEXT NOT NULL, descripcion TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS proyectos (
        id TEXT PRIMARY KEY, nombre TEXT NOT NULL, responsable TEXT NOT NULL,
        macroproyectoId TEXT
      );
      CREATE TABLE IF NOT EXISTS actividades (
        id TEXT PRIMARY KEY, nombre TEXT NOT NULL,
        tipo TEXT NOT NULL,
        fechaInicio TEXT NOT NULL, fechaFin TEXT NOT NULL,
        aprobada INTEGER DEFAULT 0, padre TEXT, proyectoId TEXT NOT NULL,
        porcentaje INTEGER DEFAULT 0, comentario TEXT DEFAULT '', orden INTEGER DEFAULT 0,
        FOREIGN KEY (proyectoId) REFERENCES proyectos(id) ON DELETE CASCADE,
        FOREIGN KEY (padre) REFERENCES actividades(id) ON DELETE SET NULL
      );
    `);
  }
}

// ─── Progress helper ──────────────────────────────────────────────────────
function getProgreso(act) {
  if (act.tipo === 'puntos') return act.porcentaje || 0;
  return act.aprobada ? 100 : 0;
}

// ─── Business Logic ───────────────────────────────────────────────────────
function getProyectos() {
  return rows(db.exec("SELECT * FROM proyectos ORDER BY nombre"));
}

function getMacroproyectos() {
  return rows(db.exec("SELECT * FROM macroproyectos ORDER BY nombre"));
}

function getActividades(proyectoId) {
  return rows(db.exec("SELECT * FROM actividades WHERE proyectoId=? ORDER BY orden ASC, fechaInicio", [proyectoId]));
}

function calcularFechasProyecto(proyectoId) {
  const res = db.exec("SELECT MIN(fechaInicio), MAX(fechaFin) FROM actividades WHERE proyectoId=?", [proyectoId]);
  if (!res.length || !res[0].values[0][0]) return { inicio: null, fin: null };
  return { inicio: res[0].values[0][0], fin: res[0].values[0][1] };
}

function calcularEstadoYCumplimiento(proyectoId) {
  const acts = getActividades(proyectoId);
  if (!acts.length) return { estado: 'Activo', cumplimiento: 0 };

  const conHijos = new Set(acts.filter(a => a.padre).map(a => a.padre));
  const hojas = acts.filter(a => !conHijos.has(a.id));

  const cumplimiento = hojas.length
    ? Math.round(hojas.reduce((s, h) => s + getProgreso(h), 0) / hojas.length)
    : 0;

  const todasCompletas = hojas.every(h => getProgreso(h) === 100);
  const { fin } = calcularFechasProyecto(proyectoId);
  let estado = 'Activo';
  if (todasCompletas) estado = 'Cumplido';
  else if (fin && todayStr() > fin) estado = 'Inconcluso';

  return { estado, cumplimiento };
}

function calcularProgresoActividad(actId, acts) {
  const hijos = acts.filter(a => a.padre === actId);
  if (!hijos.length) {
    const act = acts.find(a => a.id === actId);
    return act ? getProgreso(act) : 0;
  }
  return Math.round(hijos.reduce((s, h) => s + calcularProgresoActividad(h.id, acts), 0) / hijos.length);
}

// ─── Reordenamiento cronológico de actividades ────────────────────────────
function reordenarActividadesPorFecha(proyectoId) {
  const acts = getActividades(proyectoId);
  const raices = acts.filter(a => !a.padre).sort((a, b) => a.fechaInicio.localeCompare(b.fechaInicio));
  const hijos = acts.filter(a => a.padre);
  
  let orden = 1;
  raices.forEach(r => {
    db.run("UPDATE actividades SET orden=? WHERE id=?", [orden++, r.id]);
    const hijosDeR = hijos.filter(h => h.padre === r.id);
    hijosDeR.forEach(h => {
      db.run("UPDATE actividades SET orden=? WHERE id=?", [orden++, h.id]);
    });
  });
  
  hijos.filter(h => !raices.find(r => r.id === h.padre)).forEach(h => {
    db.run("UPDATE actividades SET orden=? WHERE id=?", [orden++, h.id]);
  });
}

// ─── Validación de fechas de subactividades ───────────────────────────────
function validarYAjustarFechasSubactividad(actividadId, fechaInicioPropuesta, padre) {
  if (!padre) return fechaInicioPropuesta;
  
  const padreAct = rows(db.exec("SELECT * FROM actividades WHERE id=?", [padre]))[0];
  if (!padreAct) return fechaInicioPropuesta;
  
  if (fechaInicioPropuesta < padreAct.fechaInicio) {
    mostrarToast(`Fecha ajustada: la subactividad no puede iniciar antes que su actividad padre (${fmtDate(padreAct.fechaInicio)})`);
    return padreAct.fechaInicio;
  }
  
  return fechaInicioPropuesta;
}

// ─── Ajustar fechas de hijos cuando cambia la fecha del padre ─────────────
function ajustarFechasHijosSiNecesario(padreId, nuevaFechaInicio) {
  const hijos = rows(db.exec("SELECT * FROM actividades WHERE padre=?", [padreId]));
  hijos.forEach(hijo => {
    if (hijo.fechaInicio < nuevaFechaInicio) {
      db.run("UPDATE actividades SET fechaInicio=? WHERE id=?", [nuevaFechaInicio, hijo.id]);
    }
  });
}

// ─── Sidebar Collapse ─────────────────────────────────────────────────────
function toggleSidebar() {
  const sidebar = document.querySelector('.projects-sidebar');
  const isCollapsed = sidebar.classList.toggle('sidebar--collapsed');
  localStorage.setItem('sidebarCollapsed', isCollapsed ? '1' : '0');
  renderProyectos();
}

function initSidebarState() {
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    document.querySelector('.projects-sidebar').classList.add('sidebar--collapsed');
  }
}

// ─── Toggle macroproyecto ─────────────────────────────────────────────────
function toggleMacroproyecto(macroId) {
  const state = getMacroCollapseState();
  const isCollapsed = !state[macroId];
  setMacroCollapseState(macroId, isCollapsed);
  renderProyectos();
}

// ─── Section Collapse ─────────────────────────────────────────────────────
function getSectionState(key) {
  try {
    const stored = localStorage.getItem('sectionCollapsed');
    const map = stored ? JSON.parse(stored) : {};
    return !!map[key];
  } catch (e) { return false; }
}

function setSectionState(key, collapsed) {
  try {
    const stored = localStorage.getItem('sectionCollapsed');
    const map = stored ? JSON.parse(stored) : {};
    map[key] = collapsed;
    localStorage.setItem('sectionCollapsed', JSON.stringify(map));
  } catch (e) { }
}

function toggleSection(key) {
  const body = document.getElementById(`section-body-${key}`);
  const chevron = document.getElementById(`section-chevron-${key}`);
  if (!body) return;
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  setSectionState(key, !isHidden);
  if (chevron) chevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
}

function applySectionState(key) {
  const body = document.getElementById(`section-body-${key}`);
  const chevron = document.getElementById(`section-chevron-${key}`);
  if (!body) return;
  const collapsed = getSectionState(key);
  body.style.display = collapsed ? 'none' : '';
  if (chevron) chevron.style.transform = collapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
}

// ─── Render: Proyectos Sidebar (con desplegables) ─────────────────────────
function renderProyectos() {
  const list = document.getElementById('projectsList');
  list.innerHTML = '';

  const macros = getMacroproyectos();
  const proyectos = getProyectos();
  const sidebar = document.querySelector('.projects-sidebar');
  const isCollapsed = sidebar && sidebar.classList.contains('sidebar--collapsed');
  const macroState = getMacroCollapseState();

  // Proyectos sin macroproyecto
  const sinMacro = proyectos.filter(p => !p.macroproyectoId);
  sinMacro.forEach(p => {
    list.appendChild(buildProjectItem(p, isCollapsed, false));
  });

  // Macroproyectos con sus proyectos
  macros.forEach(m => {
    const mProyectos = proyectos.filter(p => p.macroproyectoId === m.id);

    const section = document.createElement('div');
    section.className = 'macro-section';

    if (!isCollapsed) {
      const header = document.createElement('div');
      header.className = 'macro-section-header';
      const isExpanded = !macroState[m.id];
      const chevron = isExpanded ? '▼' : '▶';
      
      header.innerHTML = `
        <div class="macro-header-content" onclick="toggleMacroproyecto('${m.id}')">
          <span class="macro-chevron">${chevron}</span>
          <span class="macro-name">${m.nombre}</span>
        </div>
        <div class="macro-actions">
          <button class="btn-icon" title="Editar" onclick="openMacroproyectoModal('${m.id}'); event.stopPropagation();">✏️</button>
          <button class="btn-icon btn-icon--danger" title="Eliminar" onclick="deleteMacroproyecto('${m.id}'); event.stopPropagation();">🗑️</button>
        </div>`;
      section.appendChild(header);

      // Proyectos del macroproyecto (solo si está expandido)
      if (isExpanded) {
        mProyectos.forEach(p => {
          section.appendChild(buildProjectItem(p, isCollapsed, true));
        });
      }
    } else {
      // Sidebar colapsado: mostrar proyectos siempre
      mProyectos.forEach(p => {
        section.appendChild(buildProjectItem(p, isCollapsed, false));
      });
    }

    list.appendChild(section);
  });

  // Botón para añadir macroproyecto
  if (!isCollapsed) {
    const addMacroBtn = document.createElement('div');
    addMacroBtn.className = 'sidebar-add-macro';
    addMacroBtn.innerHTML = `<button class="btn btn--ghost btn--sm" onclick="openMacroproyectoModal()" style="width:100%;justify-content:center;">+ Nuevo macroproyecto</button>`;
    list.appendChild(addMacroBtn);
  }
}

function buildProjectItem(p, isCollapsed, indented) {
  const { estado, cumplimiento } = calcularEstadoYCumplimiento(p.id);
  const statusClass = estado === 'Cumplido' ? 'status-cumplido'
    : estado === 'Inconcluso' ? 'status-inconcluso' : 'status-activo';

  const div = document.createElement('div');
  div.className = 'project-item' + (p.id === currentProjectId ? ' active' : '') + (indented ? ' project-item--indented' : '');

  if (isCollapsed) {
    div.title = `${p.nombre} — ${estado} (${cumplimiento}%)`;
    
    // Si tiene macroproyecto, agregar indicador
    if (p.macroproyectoId) {
      const macros = getMacroproyectos();
      const macro = macros.find(m => m.id === p.macroproyectoId);
      const macroInicial = macro ? macro.nombre.charAt(0).toUpperCase() : 'M';
      div.title = `[${macroInicial}] ${p.nombre} — ${estado} (${cumplimiento}%)`;
      div.innerHTML = `
        <span class="project-item-initial ${statusClass}">${p.nombre.charAt(0).toUpperCase()}</span>
        <span class="project-macro-badge">${macroInicial}</span>
      `;
    } else {
      div.innerHTML = `<span class="project-item-initial ${statusClass}">${p.nombre.charAt(0).toUpperCase()}</span>`;
    }
  } else {
    div.innerHTML = `
      <h3>${p.nombre}</h3>
      <div class="project-responsible">${p.responsable}</div>
      <span class="project-status-badge ${statusClass}">${estado}</span>
    `;
  }
  div.onclick = () => selectProject(p.id);
  return div;
}

function selectProject(id) {
  currentProjectId = id;
  selectedActivityIds.clear();
  renderProyectos();
  renderDetalleProyecto();
}

// ─── Render: Detalle Proyecto ─────────────────────────────────────────────
function renderDetalleProyecto() {
  const empty = document.getElementById('emptyProjectState');
  const detail = document.getElementById('projectDetail');
  if (!currentProjectId) {
    empty.style.display = '';
    detail.style.display = 'none';
    return;
  }
  const res = db.exec("SELECT * FROM proyectos WHERE id=?", [currentProjectId]);
  const p = rows(res)[0];
  if (!p) return;

  const { inicio, fin } = calcularFechasProyecto(currentProjectId);
  const { estado, cumplimiento } = calcularEstadoYCumplimiento(currentProjectId);

  empty.style.display = 'none';
  detail.style.display = '';

  document.getElementById('detailProjectName').textContent = p.nombre;
  document.getElementById('detailProjectResponsible').textContent = p.responsable;
  document.getElementById('detailProjectStartDate').textContent = fmtDate(inicio);
  document.getElementById('detailProjectEndDate').textContent = fmtDate(fin);
  document.getElementById('detailProjectStatus').textContent = estado;
  document.getElementById('detailProjectProgress').textContent = cumplimiento + '%';
  document.getElementById('detailProjectProgressBar').style.width = cumplimiento + '%';

  applySectionState('header');
  applySectionState('activities');
  applySectionState('gantt');

  renderActividades();
  renderGanttProyecto();
  
  const copyBtn = document.getElementById('copySelectedBtn');
  if (copyBtn) {
    copyBtn.style.display = selectedActivityIds.size > 0 ? '' : 'none';
  }
}

// ─── Render: Actividades Table (con drag & drop) ──────────────────────────
function renderActividades() {
  const acts = getActividades(currentProjectId);
  const tbody = document.getElementById('activitiesTableBody');
  tbody.innerHTML = '';

  if (!acts.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--ink-muted);">
      Sin actividades. Crea una nueva.</td></tr>`;
    if (activitiesSortable) {
      activitiesSortable.destroy();
      activitiesSortable = null;
    }
    return;
  }

  const conHijos = new Set(acts.filter(a => a.padre).map(a => a.padre));
  
  // Construir estructura ordenada
  const ordered = [];
  const raices = acts.filter(a => !a.padre);
  const hijos = acts.filter(a => a.padre);
  
  raices.forEach(r => {
    ordered.push({ act: r, indent: false });
    const hijosDeR = hijos.filter(h => h.padre === r.id);
    hijosDeR.forEach(h => ordered.push({ act: h, indent: true }));
  });
  
  hijos.filter(h => !raices.find(r => r.id === h.padre))
    .forEach(h => ordered.push({ act: h, indent: false }));

  ordered.forEach(({ act, indent }) => {
    const esPadre = conHijos.has(act.id);
    const progreso = esPadre ? calcularProgresoActividad(act.id, acts) : getProgreso(act);

    let badge;
    if (act.tipo === 'puntos') {
      badge = `<span class="badge-approved" style="background:var(--accent-soft);color:var(--accent-hover);">${progreso}%</span>`;
    } else {
      badge = act.aprobada
        ? `<span class="badge-approved badge-approved--yes">✓ Aprobada</span>`
        : `<span class="badge-approved badge-approved--no">Pendiente</span>`;
    }

    const tipoLabel = act.tipo === 'reunion' ? 'Reunión' : act.tipo === 'puntos' ? 'Puntos' : 'Continua';

    let avanceHtml = `<span>${progreso}%</span>`;
    if (act.comentario && act.comentario.trim()) {
      avanceHtml += ` <button class="btn-icon" title="Ver comentario" onclick="mostrarComentario('${act.id}')">💬</button>`;
    }

    const tr = document.createElement('tr');
    tr.setAttribute('data-id', act.id);
    tr.innerHTML = `
      <td style="text-align:center;">
        <input type="checkbox" class="activity-checkbox" data-id="${act.id}" 
          ${selectedActivityIds.has(act.id) ? 'checked' : ''} 
          onchange="toggleActivitySelection('${act.id}')" />
      </td>
      <td class="drag-handle" style="cursor:move;text-align:center;" title="Arrastra para reordenar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </td>
      <td style="${indent ? 'padding-left:2rem;' : ''}">${indent ? '↳ ' : ''}${act.nombre}</td>
      <td>${tipoLabel}</td>
      <td>${fmtDate(act.fechaInicio)}</td>
      <td>${fmtDate(act.fechaFin)}</td>
      <td>${badge}</td>
      <td>${avanceHtml}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn--ghost btn--sm" onclick="editActivity('${act.id}')">Editar</button>
        <button class="btn btn--ghost btn--sm" title="Copiar actividad a otro proyecto" onclick="openCopyActivityModal('${act.id}')">📋</button>
        <button class="btn btn--ghost-danger btn--sm" onclick="deleteActivity('${act.id}')">Eliminar</button>
      </td>`;
    tbody.appendChild(tr);
  });

  // Inicializar SortableJS
  if (activitiesSortable) {
    activitiesSortable.destroy();
  }
  
  activitiesSortable = new Sortable(tbody, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    onEnd: function(evt) {
      const actividadId = evt.item.getAttribute('data-id');
      const newIndex = evt.newIndex;
      actualizarOrdenDespuesDragDrop(actividadId, newIndex);
    }
  });
  
  updateSelectAllCheckbox();
}

// ─── Actualizar orden después de drag & drop ──────────────────────────────
function actualizarOrdenDespuesDragDrop(actividadId, newIndex) {
  const acts = getActividades(currentProjectId);
  const act = acts.find(a => a.id === actividadId);
  if (!act) return;
  
  // Obtener IDs en el orden actual de la tabla
  const tbody = document.getElementById('activitiesTableBody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  const idsOrdenados = rows.map(row => row.getAttribute('data-id')).filter(id => id);
  
  // Reasignar orden según la nueva posición
  idsOrdenados.forEach((id, idx) => {
    db.run("UPDATE actividades SET orden=? WHERE id=?", [idx + 1, id]);
  });
  
  guardarBDenLocalStorage();
  renderDetalleProyecto();
}

// ─── Selección múltiple ───────────────────────────────────────────────────
function toggleActivitySelection(id) {
  if (selectedActivityIds.has(id)) {
    selectedActivityIds.delete(id);
  } else {
    selectedActivityIds.add(id);
  }
  updateSelectAllCheckbox();
  const copyBtn = document.getElementById('copySelectedBtn');
  if (copyBtn) {
    copyBtn.style.display = selectedActivityIds.size > 0 ? '' : 'none';
  }
}

function toggleSelectAll() {
  const checkbox = document.getElementById('selectAllActivities');
  const acts = getActividades(currentProjectId);
  
  if (checkbox.checked) {
    acts.forEach(a => selectedActivityIds.add(a.id));
  } else {
    selectedActivityIds.clear();
  }
  
  renderActividades();
}

function updateSelectAllCheckbox() {
  const checkbox = document.getElementById('selectAllActivities');
  const acts = getActividades(currentProjectId);
  
  if (!checkbox) return;
  
  if (acts.length === 0) {
    checkbox.checked = false;
    checkbox.indeterminate = false;
  } else if (selectedActivityIds.size === acts.length) {
    checkbox.checked = true;
    checkbox.indeterminate = false;
  } else if (selectedActivityIds.size > 0) {
    checkbox.checked = false;
    checkbox.indeterminate = true;
  } else {
    checkbox.checked = false;
    checkbox.indeterminate = false;
  }
}

// ─── Comentario persistente ───────────────────────────────────────────────
function mostrarComentario(actId) {
  const acts = getActividades(currentProjectId);
  const act = acts.find(a => a.id === actId);
  if (!act) return;

  let panel = document.getElementById('commentPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'commentPanel';
    panel.className = 'comment-panel';
    document.body.appendChild(panel);
  }

  const progreso = getProgreso(act);
  panel.innerHTML = `
    <div class="comment-panel-header">
      <strong>${act.nombre}</strong>
      <button class="comment-panel-close" onclick="cerrarComentario()">✕</button>
    </div>
    <div class="comment-panel-body">
      <div class="comment-panel-meta">Avance: <strong>${progreso}%</strong></div>
      <p class="comment-panel-text">${act.comentario || '<em>Sin comentario</em>'}</p>
    </div>
  `;
  panel.style.display = 'block';
  setTimeout(() => { document.addEventListener('click', handleOutsideCommentClick); }, 50);
}

function cerrarComentario() {
  const panel = document.getElementById('commentPanel');
  if (panel) panel.style.display = 'none';
  document.removeEventListener('click', handleOutsideCommentClick);
}

function handleOutsideCommentClick(e) {
  const panel = document.getElementById('commentPanel');
  if (panel && !panel.contains(e.target)) {
    cerrarComentario();
  }
}
// ─── Render: Gantt Proyecto ───────────────────────────────────────────────
function renderGanttProyecto() {
  const container = document.getElementById('projectGanttContainer');
  container.innerHTML = '';
  ganttProyecto = null;

  const acts = getActividades(currentProjectId);
  if (!acts.length) {
    container.innerHTML = '<p style="padding:1rem;color:var(--ink-muted);">Sin actividades para mostrar.</p>';
    return;
  }

  const tasks = acts.map(a => {
    const progreso = getProgreso(a);
    return {
      id: a.id,
      name: `${a.nombre} (${progreso}%)`,
      start: a.fechaInicio,
      end: a.tipo === 'reunion' ? a.fechaInicio : a.fechaFin,
      progress: progreso,
      dependencies: a.padre || '',
      custom_class: progreso === 100 ? 'bar-completed' : 'bar-pending'
    };
  });

  try {
    ganttProyecto = new Gantt(container, tasks, {
      view_mode: 'Week',
      date_format: 'YYYY-MM-DD',
      bar_height: 28,
      padding: 18,
      on_click: (task) => mostrarTooltipGantt(task, acts)
    });
  } catch (e) { console.error('Gantt proyecto:', e); }
}

// ─── Gantt Tooltip Persistente ────────────────────────────────────────────
function mostrarTooltipGantt(task, acts) {
  const act = acts.find(a => a.id === task.id);
  if (!act) return;

  let tooltip = document.getElementById('ganttTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'ganttTooltip';
    tooltip.className = 'gantt-tooltip-persistent';
    document.body.appendChild(tooltip);
  }

  const progreso = getProgreso(act);
  const tipoLabel = act.tipo === 'reunion' ? 'Reunión' : act.tipo === 'puntos' ? 'Puntos' : 'Continua';

  tooltip.innerHTML = `
    <div class="gantt-tooltip-header">
      <span>${act.nombre}</span>
      <button class="gantt-tooltip-close" onclick="cerrarTooltipGantt()">✕</button>
    </div>
    <div class="gantt-tooltip-body">
      <div><span class="gantt-tt-label">Tipo:</span> ${tipoLabel}</div>
      <div><span class="gantt-tt-label">Inicio:</span> ${fmtDate(act.fechaInicio)}</div>
      <div><span class="gantt-tt-label">Fin:</span> ${fmtDate(act.fechaFin)}</div>
      <div><span class="gantt-tt-label">Avance:</span> <strong>${progreso}%</strong></div>
      ${act.comentario && act.comentario.trim()
        ? `<div class="gantt-tooltip-comment"><span class="gantt-tt-label">Comentario:</span> ${act.comentario}</div>`
        : `<div style="color:var(--ink-muted);font-style:italic;margin-top:6px;">Sin comentario</div>`
      }
    </div>
  `;
  tooltip.style.display = 'block';
  setTimeout(() => { document.addEventListener('click', handleOutsideGanttTooltip); }, 50);
}

function cerrarTooltipGantt() {
  const t = document.getElementById('ganttTooltip');
  if (t) t.style.display = 'none';
  document.removeEventListener('click', handleOutsideGanttTooltip);
}

function handleOutsideGanttTooltip(e) {
  const t = document.getElementById('ganttTooltip');
  if (t && !t.contains(e.target)) {
    cerrarTooltipGantt();
  }
}

// ─── Render: Dashboard ───────────────────────────────────────────────────
function getProyectosFiltrados() {
  const proyectos = getProyectos();
  if (!dashboardFiltroMacro) return proyectos;
  return proyectos.filter(p => p.macroproyectoId === dashboardFiltroMacro);
}

function calcularKPIs() {
  const proyectos = getProyectosFiltrados();
  
  const total = proyectos.length;
  const activos = proyectos.filter(p => calcularEstadoYCumplimiento(p.id).estado === 'Activo').length;
  
  const cumplimientos = proyectos.map(p => calcularEstadoYCumplimiento(p.id).cumplimiento);
  const cumplimientoPromedio = cumplimientos.length ? Math.round(cumplimientos.reduce((a, b) => a + b, 0) / cumplimientos.length) : 0;
  
  let actividadesPendientes = 0;
  proyectos.forEach(p => {
    const acts = getActividades(p.id);
    const conHijos = new Set(acts.filter(a => a.padre).map(a => a.padre));
    const hojas = acts.filter(a => !conHijos.has(a.id));
    actividadesPendientes += hojas.filter(h => getProgreso(h) < 100).length;
  });
  
  return { total, activos, cumplimientoPromedio, actividadesPendientes };
}

function renderKPIs() {
  const kpis = calcularKPIs();
  document.getElementById('kpiTotalProyectos').textContent = kpis.total;
  document.getElementById('kpiProyectosActivos').textContent = kpis.activos;
  document.getElementById('kpiCumplimientoPromedio').textContent = kpis.cumplimientoPromedio + '%';
  document.getElementById('kpiActividadesPendientes').textContent = kpis.actividadesPendientes;
}

function renderDashboardGantt() {
  const container = document.getElementById('dashboardGanttContainer');
  container.innerHTML = '';
  if (ganttDashboard) {
    try { ganttDashboard.destroy(); } catch (e) {}
    ganttDashboard = null;
  }

  const proyectos = getProyectosFiltrados();
  const tasks = proyectos.map(p => {
    const { inicio, fin } = calcularFechasProyecto(p.id);
    if (!inicio || !fin) return null;
    const { cumplimiento } = calcularEstadoYCumplimiento(p.id);
    if (cumplimiento === 100) return null; // Filtrar proyectos 100% completos
    return {
      id: p.id,
      name: p.nombre.length > 20 ? p.nombre.substring(0, 20) + '...' : p.nombre,
      start: inicio,
      end: fin,
      progress: cumplimiento,
      dependencies: '',
      custom_class: 'bar-project'
    };
  }).filter(Boolean);

  if (!tasks.length) {
    container.innerHTML = '<p style="padding:1rem;color:var(--ink-muted);">No hay proyectos activos para mostrar.</p>';
    return;
  }
  
  try {
    ganttDashboard = new Gantt(container, tasks, {
      view_mode: 'Month',
      date_format: 'YYYY-MM-DD',
      bar_height: 20,
      padding: 14,
      on_click: (task) => {
        const p = proyectos.find(pr => pr.id === task.id);
        if (!p) return;
        const { cumplimiento } = calcularEstadoYCumplimiento(p.id);
        const { inicio, fin } = calcularFechasProyecto(p.id);
        alert(`${p.nombre}\nResponsable: ${p.responsable}\nInicio: ${fmtDate(inicio)}\nFin: ${fmtDate(fin)}\nCumplimiento: ${cumplimiento}%`);
      }
    });
  } catch (e) { 
    console.error('Gantt dashboard:', e); 
    container.innerHTML = '<p style="padding:1rem;color:var(--rose);">Error al renderizar el Gantt.</p>';
  }
}

function renderGraficaCumplimiento() {
  const proyectos = getProyectosFiltrados();
  if (!proyectos.length) {
    const canvas = document.getElementById('complianceChart');
    if (canvas) {
      const parent = canvas.parentElement;
      parent.innerHTML = '<p style="padding:2rem;text-align:center;color:var(--ink-muted);">No hay proyectos para mostrar.</p>';
    }
    return;
  }

  const datosProyectos = proyectos.map(p => {
    const { cumplimiento } = calcularEstadoYCumplimiento(p.id);
    const { inicio, fin } = calcularFechasProyecto(p.id);
    return {
      nombre: p.nombre,
      responsable: p.responsable,
      cumplimiento,
      inicio,
      fin
    };
  });

  const labels = datosProyectos.map(p => p.nombre);
  const data = datosProyectos.map(p => p.cumplimiento);
  const colors = data.map(c => {
    if (c >= 80) return '#5ca069'; // Verde éxito
    if (c >= 50) return '#CFF09F'; // Amarillo/verde claro
    return '#B85C5C'; // Rojo (mantener para errores)
  });

  const canvas = document.getElementById('complianceChart');
  if (!canvas) return;
  if (complianceChart) { 
    complianceChart.destroy(); 
    complianceChart = null; 
  }

  complianceChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Cumplimiento',
        data,
        backgroundColor: colors,
        borderRadius: 6,
        borderSkipped: false
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { 
          beginAtZero: true, 
          max: 100, 
          ticks: { callback: v => v + '%' }
        },
        y: {
          ticks: {
            font: { size: 12 },
            color: '#4A4640'
          }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (ctx) => {
              const idx = ctx[0].dataIndex;
              return datosProyectos[idx].nombre;
            },
            label: (ctx) => {
              const idx = ctx.dataIndex;
              const p = datosProyectos[idx];
              return [
                `Responsable: ${p.responsable}`,
                `Inicio: ${fmtDate(p.inicio)}`,
                `Fin: ${fmtDate(p.fin)}`,
                `Cumplimiento: ${p.cumplimiento}%`
              ];
            }
          }
        },
        datalabels: false
      },
      layout: {
        padding: { right: 40 }
      }
    },
    plugins: [{
      id: 'customLabels',
      afterDatasetsDraw: (chart) => {
        const ctx = chart.ctx;
        ctx.font = '600 11px Karla';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        
        chart.data.datasets.forEach((dataset, i) => {
          const meta = chart.getDatasetMeta(i);
          meta.data.forEach((bar, index) => {
            const value = dataset.data[index];
            const x = bar.x + 8;
            const y = bar.y;
            
            ctx.fillStyle = '#1A1714';
            ctx.fillText(value + '%', x, y);
          });
        });
      }
    }]
  });
}

function renderProximasActividades() {
  const container = document.getElementById('upcomingActivitiesContainer');
  const proyectos = getProyectosFiltrados();
  
  const todasActividades = [];
  proyectos.forEach(p => {
    const acts = getActividades(p.id);
    const conHijos = new Set(acts.filter(a => a.padre).map(a => a.padre));
    const hojas = acts.filter(a => !conHijos.has(a.id) && getProgreso(a) < 100);
    
    hojas.forEach(act => {
      todasActividades.push({
        ...act,
        proyectoNombre: p.nombre,
        proyectoId: p.id
      });
    });
  });
  
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  
  const actividadesConDias = todasActividades.map(act => {
    const fechaFin = new Date(act.fechaFin);
    fechaFin.setHours(0, 0, 0, 0);
    
    // Cálculo simple: diferencia de días calendario
    // Ejemplo: 20/02 a 23/02 = 3 días, 21/02 a 23/02 = 2 días
    const dias = Math.round((fechaFin - hoy) / (1000 * 60 * 60 * 24));
    
    return { ...act, diasRestantes: dias };
  });
  
  actividadesConDias.sort((a, b) => a.diasRestantes - b.diasRestantes);
  const proximas = actividadesConDias.slice(0, 5);
  
  if (!proximas.length) {
    container.innerHTML = '<div class="upcoming-activities-empty">No hay actividades pendientes próximas a vencer.</div>';
    return;
  }
  
  const lista = document.createElement('div');
  lista.className = 'upcoming-activities-list';
  
  proximas.forEach(act => {
    const item = document.createElement('div');
    item.className = 'upcoming-activity-item';
    item.onclick = () => {
      switchMainTab('projects');
      selectProject(act.proyectoId);
    };
    
    let diasTexto = '';
    let diasClase = 'upcoming-activity-days--ok';
    
    if (act.diasRestantes < 0) {
      diasTexto = 'Vencida';
      diasClase = 'upcoming-activity-days--urgent';
    } else if (act.diasRestantes === 0) {
      diasTexto = 'Vence Hoy';
      diasClase = 'upcoming-activity-days--urgent';
    } else if (act.diasRestantes === 1) {
      diasTexto = 'Mañana';
      diasClase = 'upcoming-activity-days--urgent';
    } else if (act.diasRestantes < 3) {
      diasTexto = `${act.diasRestantes} días`;
      diasClase = 'upcoming-activity-days--urgent';
    } else if (act.diasRestantes <= 7) {
      diasTexto = `${act.diasRestantes} días`;
      diasClase = 'upcoming-activity-days--warning';
    } else {
      diasTexto = `${act.diasRestantes} días`;
      diasClase = 'upcoming-activity-days--ok';
    }
    
    item.innerHTML = `
      <div class="upcoming-activity-info">
        <div class="upcoming-activity-name">${act.nombre}</div>
        <div class="upcoming-activity-project">${act.proyectoNombre}</div>
      </div>
      <div class="upcoming-activity-date">${fmtDate(act.fechaFin)}</div>
      <div class="upcoming-activity-days ${diasClase}">${diasTexto}</div>
    `;
    
    lista.appendChild(item);
  });
  
  container.innerHTML = '';
  container.appendChild(lista);
}

function cargarFiltroMacroproyectos() {
  const select = document.getElementById('dashboardMacroFilter');
  if (!select) return;
  
  select.innerHTML = '<option value="">Todos</option>';
  const macros = getMacroproyectos();
  macros.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.nombre;
    select.appendChild(opt);
  });
  
  select.value = dashboardFiltroMacro;
}

function aplicarFiltroDashboard() {
  const select = document.getElementById('dashboardMacroFilter');
  dashboardFiltroMacro = select ? select.value : '';
  renderKPIs();
  renderDashboardGantt();
  renderGraficaCumplimiento();
  renderProximasActividades();
}

// ─── Tabs ─────────────────────────────────────────────────────────────────
function switchMainTab(tab) {
  document.querySelectorAll('.nav-item').forEach((btn, i) => {
    btn.classList.toggle('active', (tab === 'projects' && i === 0) || (tab === 'dashboard' && i === 1));
  });
  document.getElementById('projects-module').classList.toggle('active', tab === 'projects');
  document.getElementById('dashboard-module').classList.toggle('active', tab === 'dashboard');
  if (tab === 'dashboard') {
    cargarFiltroMacroproyectos();
    renderKPIs();
    renderDashboardGantt();
    renderGraficaCumplimiento();
    renderProximasActividades();
  }
}

// ─── DEPRECATED: Ya no se usa (tabs eliminados) ───────────────────────────
// function switchProjectTab(tab) {
//   const btns = document.querySelectorAll('.tab-btn');
//   btns[0].classList.toggle('active', tab === 'activities');
//   btns[1].classList.toggle('active', tab === 'gantt');
//   document.getElementById('activitiesTab').classList.toggle('active', tab === 'activities');
//   document.getElementById('ganttTab').classList.toggle('active', tab === 'gantt');
//   if (tab === 'gantt') renderGanttProyecto();
// }

// ─── Modal helpers ────────────────────────────────────────────────────────
function showModal(id) { document.getElementById(id).classList.add('show'); }
function hideModal(id) { document.getElementById(id).classList.remove('show'); }

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('show');
    editingProjectId = null;
    editingActivityId = null;
    editingMacroproyectoId = null;
    copyingActivityId = null;
  }
});

// ─── Modal: Macroproyecto ─────────────────────────────────────────────────
function openMacroproyectoModal(id) {
  editingMacroproyectoId = id || null;
  document.getElementById('macroproyectoModalTitle').textContent = id ? 'Editar Macroproyecto' : 'Nuevo Macroproyecto';
  if (id) {
    const m = rows(db.exec("SELECT * FROM macroproyectos WHERE id=?", [id]))[0];
    if (m) {
      document.getElementById('macroproyectoNombre').value = m.nombre;
      document.getElementById('macroproyectoDescripcion').value = m.descripcion || '';
    }
  } else {
    document.getElementById('macroproyectoNombre').value = '';
    document.getElementById('macroproyectoDescripcion').value = '';
  }
  showModal('macroproyectoModal');
}

function closeMacroproyectoModal() {
  hideModal('macroproyectoModal');
  editingMacroproyectoId = null;
}

function saveMacroproyecto() {
  const nombre = document.getElementById('macroproyectoNombre').value.trim();
  const descripcion = document.getElementById('macroproyectoDescripcion').value.trim();
  if (!nombre) { alert('El nombre es obligatorio.'); return; }

  if (editingMacroproyectoId) {
    db.run("UPDATE macroproyectos SET nombre=?, descripcion=? WHERE id=?", [nombre, descripcion, editingMacroproyectoId]);
  } else {
    const id = uuidv4();
    db.run("INSERT INTO macroproyectos (id, nombre, descripcion) VALUES (?,?,?)", [id, nombre, descripcion]);
  }
  guardarBDenLocalStorage();
  closeMacroproyectoModal();
  renderProyectos();
}

function deleteMacroproyecto(id) {
  if (!confirm('¿Eliminar este macroproyecto? Los proyectos asociados quedarán sin macroproyecto.')) return;
  db.run("UPDATE proyectos SET macroproyectoId=NULL WHERE macroproyectoId=?", [id]);
  db.run("DELETE FROM macroproyectos WHERE id=?", [id]);
  guardarBDenLocalStorage();
  renderProyectos();
}

// ─── Modal: Proyecto ──────────────────────────────────────────────────────
function openProjectModal(editar) {
  editingProjectId = editar || null;
  document.getElementById('projectModalTitle').textContent = editar ? 'Editar Proyecto' : 'Nuevo Proyecto';

  const macroSel = document.getElementById('projectMacroproyecto');
  macroSel.innerHTML = '<option value="">Ninguno</option>';
  getMacroproyectos().forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.nombre;
    macroSel.appendChild(opt);
  });

  if (editar) {
    const p = rows(db.exec("SELECT * FROM proyectos WHERE id=?", [editar]))[0];
    if (p) {
      document.getElementById('projectName').value = p.nombre;
      document.getElementById('projectResponsible').value = p.responsable;
      macroSel.value = p.macroproyectoId || '';
    }
  } else {
    document.getElementById('projectName').value = '';
    document.getElementById('projectResponsible').value = '';
    macroSel.value = '';
  }
  showModal('projectModal');
}

function closeProjectModal() {
  hideModal('projectModal');
  editingProjectId = null;
}

function saveProject() {
  const nombre = document.getElementById('projectName').value.trim();
  const responsable = document.getElementById('projectResponsible').value.trim();
  const macroproyectoId = document.getElementById('projectMacroproyecto').value || null;
  if (!nombre || !responsable) { alert('Completa todos los campos.'); return; }

  if (editingProjectId) {
    db.run("UPDATE proyectos SET nombre=?, responsable=?, macroproyectoId=? WHERE id=?",
      [nombre, responsable, macroproyectoId, editingProjectId]);
    guardarBDenLocalStorage();
    closeProjectModal();
    renderProyectos();
    if (currentProjectId === editingProjectId) renderDetalleProyecto();
  } else {
    const id = uuidv4();
    db.run("INSERT INTO proyectos (id, nombre, responsable, macroproyectoId) VALUES (?,?,?,?)",
      [id, nombre, responsable, macroproyectoId]);
    guardarBDenLocalStorage();
    closeProjectModal();
    renderProyectos();
    selectProject(id);
  }
}

function editCurrentProject() {
  if (currentProjectId) openProjectModal(currentProjectId);
}

function deleteCurrentProject() {
  if (!currentProjectId || !confirm('¿Eliminar este proyecto y todas sus actividades?')) return;
  db.run("DELETE FROM actividades WHERE proyectoId=?", [currentProjectId]);
  db.run("DELETE FROM proyectos WHERE id=?", [currentProjectId]);
  guardarBDenLocalStorage();
  currentProjectId = null;
  renderProyectos();
  const ps = getProyectos();
  if (ps.length) selectProject(ps[0].id);
  else renderDetalleProyecto();
}

// ─── Modal: Actividad ─────────────────────────────────────────────────────
function openActivityModal(id) {
  editingActivityId = id || null;
  document.getElementById('activityModalTitle').textContent = id ? 'Editar Actividad' : 'Nueva Actividad';

  if (!document.getElementById('activityPorcentajeGroup')) {
    const form = document.getElementById('activityForm');
    const pctGroup = document.createElement('div');
    pctGroup.className = 'field';
    pctGroup.id = 'activityPorcentajeGroup';
    pctGroup.style.display = 'none';
    pctGroup.innerHTML = `
      <label class="field-label">Porcentaje de avance</label>
      <input type="number" id="activityPorcentaje" class="field-input" min="0" max="100" placeholder="0-100" value="0" />
    `;
    const comGroup = document.createElement('div');
    comGroup.className = 'field';
    comGroup.id = 'activityComentarioGroup';
    comGroup.innerHTML = `
      <label class="field-label">Comentario</label>
      <textarea id="activityComentario" class="field-input" rows="2" placeholder="Comentario opcional..." style="resize:vertical;"></textarea>
    `;
    const parentField = document.getElementById('activityParent').closest('.field');
    form.insertBefore(pctGroup, parentField);
    form.appendChild(comGroup);
  }

  const tipoSelect = document.getElementById('activityType');
  if (!tipoSelect.querySelector('option[value="puntos"]')) {
    const opt = document.createElement('option');
    opt.value = 'puntos';
    opt.textContent = 'Puntos de avance';
    tipoSelect.appendChild(opt);
  }

  const acts = getActividades(currentProjectId);
  const parentSel = document.getElementById('activityParent');
  parentSel.innerHTML = '<option value="">Ninguna (actividad principal)</option>';
  acts.forEach(a => {
    if (a.id === id) return;
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.nombre;
    parentSel.appendChild(opt);
  });

  const toggle = document.getElementById('activityApproved');
  const lbl = document.getElementById('toggleLabel');

  if (id) {
    const act = acts.find(a => a.id === id);
    if (act) {
      document.getElementById('activityName').value = act.nombre;
      document.getElementById('activityType').value = act.tipo;
      document.getElementById('activityStartDate').value = act.fechaInicio;
      document.getElementById('activityEndDate').value = act.fechaFin;
      toggle.checked = act.aprobada === 1;
      lbl.textContent = act.aprobada ? 'Aprobada' : 'Pendiente';
      parentSel.value = act.padre || '';
      if (document.getElementById('activityPorcentaje')) {
        document.getElementById('activityPorcentaje').value = act.porcentaje || 0;
      }
      if (document.getElementById('activityComentario')) {
        document.getElementById('activityComentario').value = act.comentario || '';
      }
    }
  } else {
    document.getElementById('activityName').value = '';
    document.getElementById('activityType').value = 'continua';
    document.getElementById('activityStartDate').value = '';
    document.getElementById('activityEndDate').value = '';
    toggle.checked = false;
    lbl.textContent = 'Pendiente';
    parentSel.value = '';
    if (document.getElementById('activityPorcentaje')) {
      document.getElementById('activityPorcentaje').value = 0;
    }
    if (document.getElementById('activityComentario')) {
      document.getElementById('activityComentario').value = '';
    }
  }

  handleActivityTypeChange();
  showModal('activityModal');
}

function closeActivityModal() {
  hideModal('activityModal');
  editingActivityId = null;
}

function handleActivityTypeChange() {
  const tipo = document.getElementById('activityType').value;
  const endGroup = document.getElementById('endDateGroup');
  const typeHelp = document.getElementById('typeHelp');
  const endInput = document.getElementById('activityEndDate');
  const pctGroup = document.getElementById('activityPorcentajeGroup');
  const toggleRow = document.getElementById('activityApproved').closest('.field');

  if (tipo === 'reunion') {
    endGroup.style.display = 'none';
    endInput.removeAttribute('required');
    if (typeHelp) typeHelp.textContent = 'Ocurre en un solo día';
    if (pctGroup) pctGroup.style.display = 'none';
    if (toggleRow) toggleRow.style.display = '';
  } else if (tipo === 'puntos') {
    endGroup.style.display = '';
    endInput.setAttribute('required', '');
    if (typeHelp) typeHelp.textContent = 'Avance por porcentaje manual';
    if (pctGroup) pctGroup.style.display = '';
    if (toggleRow) toggleRow.style.display = 'none';
  } else {
    endGroup.style.display = '';
    endInput.setAttribute('required', '');
    if (typeHelp) typeHelp.textContent = 'Duración de varios días';
    if (pctGroup) pctGroup.style.display = 'none';
    if (toggleRow) toggleRow.style.display = '';
  }
}


// ─── Save Activity (con validación de fechas y reordenamiento) ────────────
function saveActivity() {
  try {
    const nombre = document.getElementById('activityName').value.trim();
    const tipo = document.getElementById('activityType').value;
    const fechaInicio = document.getElementById('activityStartDate').value;
    const fechaFin = tipo === 'reunion' ? fechaInicio : document.getElementById('activityEndDate').value;
    const aprobada = document.getElementById('activityApproved').checked ? 1 : 0;
    const padre = document.getElementById('activityParent').value || null;

    let porcentaje = 0;
    if (tipo === 'puntos') {
      const pctInput = document.getElementById('activityPorcentaje');
      porcentaje = pctInput ? Math.min(100, Math.max(0, parseInt(pctInput.value, 10) || 0)) : 0;
    } else {
      porcentaje = aprobada ? 100 : 0;
    }

    const comentarioInput = document.getElementById('activityComentario');
    const comentario = comentarioInput ? comentarioInput.value.trim() : '';

    if (!nombre || !fechaInicio || (tipo !== 'reunion' && !fechaFin)) {
      alert('Completa todos los campos requeridos.');
      return;
    }

    // Validación y ajuste de fechas para subactividades
    let fechaInicioFinal = fechaInicio;
    if (padre) {
      fechaInicioFinal = validarYAjustarFechasSubactividad(editingActivityId, fechaInicio, padre);
    }

    if (editingActivityId) {
      const actAnterior = rows(db.exec("SELECT * FROM actividades WHERE id=?", [editingActivityId]))[0];
      
      db.run(
        "UPDATE actividades SET nombre=?, tipo=?, fechaInicio=?, fechaFin=?, aprobada=?, padre=?, porcentaje=?, comentario=? WHERE id=?",
        [nombre, tipo, fechaInicioFinal, fechaFin, aprobada, padre, porcentaje, comentario, editingActivityId]
      );
      
      // Si cambió la fecha de inicio de una actividad padre, ajustar hijos
      if (!actAnterior.padre && actAnterior.fechaInicio !== fechaInicioFinal) {
        ajustarFechasHijosSiNecesario(editingActivityId, fechaInicioFinal);
      }
      
      // Si es actividad principal (sin padre), reordenar por fecha
      if (!padre) {
        reordenarActividadesPorFecha(currentProjectId);
      }
    } else {
      const newId = uuidv4();
      const acts = getActividades(currentProjectId);
      const maxOrden = acts.length > 0 ? Math.max(...acts.map(a => a.orden || 0)) : 0;
      const nuevoOrden = maxOrden + 1;
      
      db.run(
        "INSERT INTO actividades (id, nombre, tipo, fechaInicio, fechaFin, aprobada, padre, proyectoId, porcentaje, comentario, orden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [newId, nombre, tipo, fechaInicioFinal, fechaFin, aprobada, padre, currentProjectId, porcentaje, comentario, nuevoOrden]
      );
      
      // Si es actividad principal, reordenar por fecha
      if (!padre) {
        reordenarActividadesPorFecha(currentProjectId);
      }
    }
    
    guardarBDenLocalStorage();
    closeActivityModal();
    renderDetalleProyecto();
    renderProyectos();
  } catch (error) {
    console.error('Error en saveActivity:', error);
    alert('Error al guardar: ' + error.message);
  }
}

function editActivity(id) { openActivityModal(id); }

function deleteActivity(id) {
  if (!confirm('¿Eliminar esta actividad?')) return;
  db.run("UPDATE actividades SET padre=NULL WHERE padre=?", [id]);
  db.run("DELETE FROM actividades WHERE id=?", [id]);
  guardarBDenLocalStorage();
  renderDetalleProyecto();
  renderProyectos();
}
// ─── Modal: Copiar Actividad ──────────────────────────────────────────────
function openCopyActivityModal(actId) {
  copyingActivityId = actId;
  const sel = document.getElementById('copyDestProject');
  sel.innerHTML = '';
  getProyectos().forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.nombre + (p.id === currentProjectId ? ' (actual)' : '');
    sel.appendChild(opt);
  });
  // Default to first other project
  const otros = getProyectos().filter(p => p.id !== currentProjectId);
  if (otros.length) sel.value = otros[0].id;
  else sel.value = currentProjectId;

  document.getElementById('copiarHijos').checked = true;
  document.getElementById('copiarComentarios').checked = true;
  showModal('copyActivityModal');
}

function closeCopyActivityModal() {
  hideModal('copyActivityModal');
  copyingActivityId = null;
}

function copyActivity() {
  if (!copyingActivityId) return;
  const destProjectId = document.getElementById('copyDestProject').value;
  const incluirHijos = document.getElementById('copiarHijos').checked;
  const copiarComentarios = document.getElementById('copiarComentarios').checked;

  if (!destProjectId) { alert('Selecciona un proyecto destino.'); return; }

  const acts = getActividades(currentProjectId);
  const actToCopy = acts.find(a => a.id === copyingActivityId);
  if (!actToCopy) return;

  // Calcular orden para actividades copiadas (al final del proyecto destino)
  const actsDestino = getActividades(destProjectId);
  let ordenBase = actsDestino.length > 0 ? Math.max(...actsDestino.map(a => a.orden || 0)) + 1 : 1;

  function insertarActividad(act, newPadre) {
    const newId = uuidv4();
    const comentario = copiarComentarios ? (act.comentario || '') : '';
    db.run(
      "INSERT INTO actividades (id, nombre, tipo, fechaInicio, fechaFin, aprobada, padre, proyectoId, porcentaje, comentario, orden) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [newId, act.nombre, act.tipo, act.fechaInicio, act.fechaFin, act.aprobada, newPadre, destProjectId, act.porcentaje || 0, comentario, ordenBase++]
    );
    if (incluirHijos) {
      acts.filter(a => a.padre === act.id).forEach(hijo => insertarActividad(hijo, newId));
    }
  }

  insertarActividad(actToCopy, null);

  guardarBDenLocalStorage();
  closeCopyActivityModal();

  if (destProjectId === currentProjectId) {
    renderDetalleProyecto();
  }
  renderProyectos();
  alert('Actividad copiada correctamente.');
}

// ─── Modal: Copiar Masivo ─────────────────────────────────────────────────
function openMassiveCopyModal() {
  if (selectedActivityIds.size === 0) {
    alert('Selecciona al menos una actividad para copiar.');
    return;
  }
  
  const sel = document.getElementById('massiveCopyDestProject');
  sel.innerHTML = '';
  getProyectos().forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.nombre + (p.id === currentProjectId ? ' (actual)' : '');
    sel.appendChild(opt);
  });
  
  // Default to first other project
  const otros = getProyectos().filter(p => p.id !== currentProjectId);
  if (otros.length) sel.value = otros[0].id;
  else sel.value = currentProjectId;

  document.getElementById('massiveCopyIncludeChildren').checked = true;
  document.getElementById('massiveCopyComments').checked = true;
  
  showModal('massiveCopyModal');
}

function closeMassiveCopyModal() {
  hideModal('massiveCopyModal');
}

function copySelectedActivities() {
  const destProjectId = document.getElementById('massiveCopyDestProject').value;
  const includeChildren = document.getElementById('massiveCopyIncludeChildren').checked;
  const copyComments = document.getElementById('massiveCopyComments').checked;
  
  if (!destProjectId) {
    alert('Selecciona un proyecto destino.');
    return;
  }
  
  if (selectedActivityIds.size === 0) {
    alert('No hay actividades seleccionadas.');
    return;
  }
  
  const acts = getActividades(currentProjectId);
  const selectedActs = acts.filter(a => selectedActivityIds.has(a.id));
  
  // Calcular orden para actividades copiadas (al final del proyecto destino)
  const actsDestino = getActividades(destProjectId);
  let ordenBase = actsDestino.length > 0 ? Math.max(...actsDestino.map(a => a.orden || 0)) + 1 : 1;
  
  // Mapa para rastrear IDs antiguos -> nuevos IDs
  const idMap = new Map();
  
  function copiarActividadConHijos(act) {
    const newId = uuidv4();
    const comentario = copyComments ? (act.comentario || '') : '';
    
    // Determinar padre: si el padre original está en el mapa, usar el nuevo ID; si no, null
    let newPadre = null;
    if (act.padre && idMap.has(act.padre)) {
      newPadre = idMap.get(act.padre);
    }
    
    db.run(
      "INSERT INTO actividades (id, nombre, tipo, fechaInicio, fechaFin, aprobada, padre, proyectoId, porcentaje, comentario, orden) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [newId, act.nombre, act.tipo, act.fechaInicio, act.fechaFin, act.aprobada, newPadre, destProjectId, act.porcentaje || 0, comentario, ordenBase++]
    );
    
    idMap.set(act.id, newId);
    
    // Si incluir hijos está activado, copiar todos los hijos (incluso los no seleccionados)
    if (includeChildren) {
      const hijos = acts.filter(a => a.padre === act.id);
      hijos.forEach(hijo => copiarActividadConHijos(hijo));
    }
  }
  
  // Copiar solo las actividades raíz seleccionadas (no copiar subactividades seleccionadas de padres también seleccionados)
  const raicesSeleccionadas = selectedActs.filter(act => {
    // Una actividad es raíz si no tiene padre O su padre no está seleccionado
    return !act.padre || !selectedActivityIds.has(act.padre);
  });
  
  raicesSeleccionadas.forEach(act => copiarActividadConHijos(act));
  
  guardarBDenLocalStorage();
  closeMassiveCopyModal();
  
  if (destProjectId === currentProjectId) {
    renderDetalleProyecto();
  }
  renderProyectos();
  
  alert(`${selectedActivityIds.size} actividad(es) copiada(s) correctamente.`);
  selectedActivityIds.clear();
}

// ─── Toggle label (live) ──────────────────────────────────────────────────
document.getElementById('activityApproved').addEventListener('change', function () {
  document.getElementById('toggleLabel').textContent = this.checked ? 'Aprobada' : 'Pendiente';
});

// ─── Exportar Reporte PDF ─────────────────────────────────────────────────
// ─── Exportar Reporte PDF (Versión definitiva) ───────────────────────────
async function exportarReportePDF() {
  try {
    const { jsPDF } = window.jspdf;
    
    if (!jsPDF) {
      throw new Error('jsPDF no está disponible');
    }
    
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true
    });
    
    // Colores (RGB)
    const colorPrimario = [26, 23, 20];
    const colorSecundario = [74, 70, 64];
    const colorMuted = [140, 133, 121];
    const colorAccent = [124, 191, 113]; // #7cbf71
    const colorVerde = [92, 160, 105]; // #5ca069
    const colorAmarillo = [207, 240, 159]; // #CFF09F
    const colorRojo = [184, 92, 92]; // #B85C5C (mantener)
    const colorFondo = [245, 243, 238];
    
    let yPos = 20;
    const margen = 20;
    const anchoUtil = 170;
    
    // Guardar estado actual
    const dashboardActive = document.getElementById('dashboard-module').classList.contains('active');
    
    // Activar Dashboard si no está activo
    if (!dashboardActive) {
      switchMainTab('dashboard');
      await new Promise(resolve => setTimeout(resolve, 800));
    } else {
      renderDashboardGantt();
      renderGraficaCumplimiento();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Forzar actualización de Chart.js
    if (complianceChart) {
      complianceChart.update();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // ========== ENCABEZADO ==========
    doc.setFillColor(...colorFondo);
    doc.rect(0, 0, 210, 50, 'F');
    
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colorPrimario);
    doc.text('Reporte de Proyectos', margen, yPos);
    
    yPos += 10;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...colorSecundario);
    
    const fechaGeneracion = new Date().toLocaleDateString('es-ES', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    doc.text(`Fecha de generacion: ${fechaGeneracion}`, margen, yPos);
    
    yPos += 6;
    doc.setTextColor(...colorMuted);
    doc.text('Gestion de Proyectos', margen, yPos);
    
    if (dashboardFiltroMacro) {
      const macro = getMacroproyectos().find(m => m.id === dashboardFiltroMacro);
      if (macro) {
        yPos += 6;
        doc.setTextColor(...colorAccent);
        doc.setFont('helvetica', 'italic');
        doc.text(`Filtrado por: ${macro.nombre}`, margen, yPos);
        doc.setFont('helvetica', 'normal');
      }
    }
    
    yPos = 55;
    
    // ========== RESUMEN EJECUTIVO ==========
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colorPrimario);
    doc.text('Resumen Ejecutivo', margen, yPos);
    
    yPos += 8;
    
    const kpis = calcularKPIs();
    const kpiData = [
      ['Total de proyectos', kpis.total.toString()],
      ['Proyectos activos', kpis.activos.toString()],
      ['Cumplimiento promedio', kpis.cumplimientoPromedio + '%'],
      ['Actividades pendientes', kpis.actividadesPendientes.toString()]
    ];
    
    doc.autoTable({
      startY: yPos,
      head: [['Indicador', 'Valor']],
      body: kpiData,
      theme: 'plain',
      headStyles: {
        fillColor: colorFondo,
        textColor: colorSecundario,
        fontStyle: 'bold',
        fontSize: 10,
        halign: 'left'
      },
      bodyStyles: {
        textColor: colorPrimario,
        fontSize: 10
      },
      alternateRowStyles: {
        fillColor: [255, 255, 255]
      },
      margin: { left: margen, right: margen },
      columnStyles: {
        0: { cellWidth: 120 },
        1: { cellWidth: 50, halign: 'right', fontStyle: 'bold', textColor: colorAccent }
      }
    });
    
    yPos = doc.lastAutoTable.finalY + 12;
    
    // ========== TABLA DE CUMPLIMIENTO POR PROYECTO ==========
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colorPrimario);
    doc.text('Cumplimiento por Proyecto', margen, yPos);
    
    yPos += 6;
    
    const proyectos = getProyectosFiltrados();
    const cumplimientoData = proyectos.map(p => {
      const { cumplimiento } = calcularEstadoYCumplimiento(p.id);
      return [p.nombre, p.responsable, cumplimiento + '%'];
    });
    
    doc.autoTable({
      startY: yPos,
      head: [['Proyecto', 'Responsable', 'Cumplimiento']],
      body: cumplimientoData,
      theme: 'striped',
      headStyles: {
        fillColor: colorPrimario,
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 9,
        halign: 'left'
      },
      bodyStyles: {
        textColor: colorSecundario,
        fontSize: 9
      },
      alternateRowStyles: {
        fillColor: colorFondo
      },
      margin: { left: margen, right: margen },
      columnStyles: {
        0: { cellWidth: 70 },
        1: { cellWidth: 60 },
        2: { cellWidth: 40, halign: 'center', fontStyle: 'bold' }
      },
      didParseCell: function(data) {
        if (data.section === 'body' && data.column.index === 2) {
          const textoValor = data.cell.text[0] || '';
          const valor = parseInt(textoValor);
          if (!isNaN(valor)) {
            if (valor >= 80) {
              data.cell.styles.textColor = colorVerde;
            } else if (valor >= 50) {
              data.cell.styles.textColor = colorAmarillo;
            } else {
              data.cell.styles.textColor = colorRojo;
            }
          }
        }
      }
    });
    
    yPos = doc.lastAutoTable.finalY + 15;
    
    // ========== GRÁFICOS ==========
    doc.addPage();
    yPos = 20;
    
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colorPrimario);
    doc.text('Graficos del Dashboard', margen, yPos);
    yPos += 12;
    
    // Capturar gráfico de barras (Chart.js)
    try {
      if (complianceChart && complianceChart.canvas) {
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...colorPrimario);
        doc.text('Cumplimiento por Proyecto', margen, yPos);
        yPos += 6;
        
        const chartImg = complianceChart.canvas.toDataURL('image/png');
        const imgWidth = 170;
        const imgHeight = 90;
        doc.addImage(chartImg, 'PNG', margen, yPos, imgWidth, imgHeight);
        yPos += imgHeight + 15;
      } else {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(...colorMuted);
        doc.text('(Grafico de cumplimiento no disponible)', margen, yPos);
        yPos += 10;
      }
    } catch (e) {
      console.error('Error capturando grafico de barras:', e);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(...colorRojo);
      doc.text('Error al capturar el grafico de cumplimiento', margen, yPos);
      yPos += 10;
    }
    
    // Capturar Gantt con html2canvas
    try {
      const ganttContainer = document.getElementById('dashboardGanttContainer');
      if (ganttContainer && ganttContainer.querySelector('.gantt')) {
        if (yPos > 180) {
          doc.addPage();
          yPos = 20;
        }
        
        ganttContainer.style.display = 'block';
        ganttContainer.style.visibility = 'visible';
        ganttContainer.style.opacity = '1';
        
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...colorPrimario);
        doc.text('Gantt General de Proyectos', margen, yPos);
        yPos += 6;
        
        const canvas = await html2canvas(ganttContainer, {
          backgroundColor: '#ffffff',
          scale: 2,
          logging: false,
          allowTaint: false,
          useCORS: true,
          windowWidth: ganttContainer.scrollWidth,
          windowHeight: ganttContainer.scrollHeight
        });
        
        const ganttImg = canvas.toDataURL('image/png');
        const imgWidth = 170;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        const maxHeight = 100;
        const finalHeight = Math.min(imgHeight, maxHeight);
        
        doc.addImage(ganttImg, 'PNG', margen, yPos, imgWidth, finalHeight);
        yPos += finalHeight + 15;
      } else {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(...colorMuted);
        doc.text('(Gantt general no disponible)', margen, yPos);
        yPos += 10;
      }
    } catch (e) {
      console.error('Error capturando Gantt:', e);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(...colorRojo);
      doc.text('Error al capturar el Gantt general', margen, yPos);
      yPos += 10;
    }
    
    // ========== LISTA DETALLADA DE PROYECTOS ==========
    doc.addPage();
    yPos = 20;
    
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colorPrimario);
    doc.text('Detalle de Proyectos', margen, yPos);
    
    yPos += 10;
    
    proyectos.forEach((proyecto, idx) => {
      if (yPos > 260) {
        doc.addPage();
        yPos = 20;
      }
      
      const { estado, cumplimiento } = calcularEstadoYCumplimiento(proyecto.id);
      const { inicio, fin } = calcularFechasProyecto(proyecto.id);
      
      if (idx > 0) {
        doc.setDrawColor(...colorMuted);
        doc.setLineWidth(0.5);
        doc.line(margen, yPos - 5, margen + anchoUtil, yPos - 5);
        yPos += 2;
      }
      
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...colorPrimario);
      const nombreProyecto = `${idx + 1}. ${proyecto.nombre}`;
      doc.text(nombreProyecto, margen, yPos);
      
      yPos += 6;
      
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...colorSecundario);
      doc.text(`Responsable: ${proyecto.responsable}`, margen + 3, yPos);
      
      yPos += 5;
      doc.text(`Estado: ${estado}`, margen + 3, yPos);
      doc.text(`Cumplimiento: ${cumplimiento}%`, margen + 50, yPos);
      
      if (inicio && fin) {
        yPos += 5;
        doc.text(`Periodo: ${fmtDate(inicio)} - ${fmtDate(fin)}`, margen + 3, yPos);
      }
      
      yPos += 8;
      
      const actividades = getActividades(proyecto.id);
      
      if (actividades.length === 0) {
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(...colorMuted);
        doc.text('Sin actividades', margen + 5, yPos);
        yPos += 6;
      } else {
        const conHijos = new Set(actividades.filter(a => a.padre).map(a => a.padre));
        
        const ordered = [];
        const raices = actividades.filter(a => !a.padre);
        const hijos = actividades.filter(a => a.padre);
        
        raices.forEach(r => {
          ordered.push({ act: r, nivel: 0 });
          const hijosDeR = hijos.filter(h => h.padre === r.id);
          hijosDeR.forEach(h => ordered.push({ act: h, nivel: 1 }));
        });
        
        hijos.filter(h => !raices.find(r => r.id === h.padre))
          .forEach(h => ordered.push({ act: h, nivel: 0 }));
        
        ordered.forEach(({ act, nivel }) => {
          if (yPos > 275) {
            doc.addPage();
            yPos = 20;
          }
          
          const sangria = margen + 5 + (nivel * 10);
          const esPadre = conHijos.has(act.id);
          const progreso = esPadre ? calcularProgresoActividad(act.id, actividades) : getProgreso(act);
          
          doc.setFontSize(9);
          doc.setFont('helvetica', nivel === 0 ? 'bold' : 'normal');
          doc.setTextColor(...colorPrimario);
          
          const prefijo = nivel === 1 ? '  > ' : '  - ';
          const maxWidth = anchoUtil - (sangria - margen) - 5;
          const nombreTexto = prefijo + act.nombre;
          const lineasNombre = doc.splitTextToSize(nombreTexto, maxWidth);
          
          doc.text(lineasNombre, sangria, yPos);
          yPos += lineasNombre.length * 4;
          
          doc.setFontSize(8);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(...colorSecundario);
          
          const tipoLabel = act.tipo === 'reunion' ? 'Reunion' : act.tipo === 'puntos' ? 'Puntos' : 'Continua';
          let detalles = `Tipo: ${tipoLabel} | ${fmtDate(act.fechaInicio)} - ${fmtDate(act.fechaFin)}`;
          
          if (act.tipo === 'puntos') {
            detalles += ` | Avance: ${progreso}%`;
          } else {
            detalles += ` | ${act.aprobada ? 'Aprobada' : 'Pendiente'}`;
          }
          
          const lineasDetalles = doc.splitTextToSize(detalles, maxWidth);
          doc.text(lineasDetalles, sangria, yPos);
          yPos += lineasDetalles.length * 4;
          
          if (act.comentario && act.comentario.trim()) {
            doc.setFont('helvetica', 'italic');
            doc.setTextColor(...colorMuted);
            const comentarioLimpio = act.comentario.trim();
            const comentarioTexto = `"${comentarioLimpio}"`;
            const lineasComentario = doc.splitTextToSize(comentarioTexto, maxWidth);
            doc.text(lineasComentario, sangria, yPos);
            yPos += lineasComentario.length * 4;
          }
          
          yPos += 2;
        });
      }
      
      yPos += 5;
    });
    
    // ========== PIE DE PÁGINA ==========
    const totalPaginas = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPaginas; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...colorMuted);
      doc.text(`Pagina ${i} de ${totalPaginas}`, 105, 287, { align: 'center' });
      doc.text('Gestion de Proyectos', margen, 287);
    }
    
    // ========== GUARDAR PDF ==========
    const nombreFiltro = dashboardFiltroMacro 
      ? '_' + getMacroproyectos().find(m => m.id === dashboardFiltroMacro)?.nombre.replace(/\s+/g, '_') 
      : '';
    const nombreArchivo = `reporte_proyectos${nombreFiltro}_${new Date().toISOString().split('T')[0]}.pdf`;
    
    doc.save(nombreArchivo);
    
    // Restaurar estado original
    if (!dashboardActive) {
      switchMainTab('projects');
    }
    
    console.log('PDF generado exitosamente:', nombreArchivo);
    
  } catch (error) {
    console.error('Error al generar el PDF:', error);
    alert('Error al generar el reporte PDF. Revise la consola para más detalles.');
    
    const dashboardActive = document.getElementById('dashboard-module').classList.contains('active');
    if (dashboardActive) {
      try { switchMainTab('projects'); } catch (e) {}
    }
  }
}

// ─── Export / Import / Reset ──────────────────────────────────────────────
function exportarBaseDatos() {
  if (!db) return;
  const blob = new Blob([db.export()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: 'proyectos.db' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importarBaseDatos(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      db = new SQL.Database(new Uint8Array(e.target.result));
      migrateDB();
      guardarBDenLocalStorage();
      currentProjectId = null;
      selectedActivityIds.clear();
      renderProyectos();
      const ps = getProyectos();
      if (ps.length) selectProject(ps[0].id);
      else renderDetalleProyecto();
    } catch (err) {
      alert('Error al importar la base de datos.');
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
  event.target.value = '';
}

function resetearBaseDatos() {
  if (!confirm('¿Restaurar datos de ejemplo? Se perderán los datos actuales.')) return;
  db = new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS macroproyectos (id TEXT PRIMARY KEY, nombre TEXT NOT NULL, descripcion TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS proyectos (id TEXT PRIMARY KEY, nombre TEXT NOT NULL, responsable TEXT NOT NULL, macroproyectoId TEXT);
    CREATE TABLE IF NOT EXISTS actividades (
      id TEXT PRIMARY KEY, nombre TEXT NOT NULL,
      tipo TEXT NOT NULL,
      fechaInicio TEXT NOT NULL, fechaFin TEXT NOT NULL,
      aprobada INTEGER DEFAULT 0, padre TEXT, proyectoId TEXT NOT NULL,
      porcentaje INTEGER DEFAULT 0, comentario TEXT DEFAULT '', orden INTEGER DEFAULT 0
    );
  `);
  guardarBDenLocalStorage();
  currentProjectId = null;
  selectedActivityIds.clear();
  renderProyectos();
  renderDetalleProyecto();
}

// ─── Init ─────────────────────────────────────────────────────────────────
async function init() {
  try {
    await initDB();
  } catch (e) {
    console.error('Error inicializando BD:', e);
  }

  const loading = document.getElementById('loadingScreen');
  loading.classList.add('hidden');
  setTimeout(() => { loading.style.display = 'none'; }, 500);

  const dot = document.querySelector('#dbIndicator .db-dot');
  if (dot) dot.style.background = '#5ca069';

  initSidebarState();
  renderProyectos();
  const ps = getProyectos();
  if (ps.length) selectProject(ps[0].id);
  else renderDetalleProyecto();
}

init();