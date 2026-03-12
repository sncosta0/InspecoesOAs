// ============================================================
// Inspeções OA - Bridge Inspection PWA
// ============================================================

(function () {
    'use strict';

    // ----------------------------------------------------------
    // Typed Lists (Locations, Anomalies, Works)
    // ----------------------------------------------------------
    const LOCATIONS = [
        'Tabuleiro',
        'Viga principal',
        'Viga transversal',
        'Laje',
        'Pilar',
        'Encontro',
        'Fundação',
        'Aparelho de apoio',
        'Junta de dilatação',
        'Guarda-corpos',
        'Cornija',
        'Passeio',
        'Guarda de segurança',
        'Sistema de drenagem',
        'Talude',
        'Muro de avenida',
        'Viga de bordadura',
        'Carlinga',
        'Pré-laje',
        'Outro',
    ];

    const ANOMALIES = [
        'Fissura',
        'Fenda',
        'Delaminação',
        'Eflorescência',
        'Corrosão de armaduras',
        'Corrosão metálica',
        'Descasque de betão',
        'Desgaste',
        'Infiltração',
        'Manchas de humidade',
        'Manchas de ferrugem',
        'Deformação',
        'Assentamento',
        'Inclinação',
        'Rotura',
        'Ausência de elemento',
        'Obstrução de drenagem',
        'Vegetação',
        'Grafiti',
        'Dano de impacto',
        'Outro',
    ];

    const WORKS = [
        'Reparação de betão',
        'Injeção de fissuras',
        'Proteção anticorrosiva',
        'Substituição de aparelho de apoio',
        'Substituição de junta de dilatação',
        'Reparação de guarda-corpos',
        'Limpeza de drenagem',
        'Impermeabilização',
        'Pintura',
        'Limpeza geral',
        'Remoção de vegetação',
        'Reforço estrutural',
        'Substituição de elemento',
        'Monitorização',
        'Estudo específico',
        'Outro',
    ];

    // ----------------------------------------------------------
    // IndexedDB Setup
    // ----------------------------------------------------------
    const DB_NAME = 'InspecoesOA';
    const DB_VERSION = 1;
    let db = null;

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const database = e.target.result;
                if (!database.objectStoreNames.contains('inspections')) {
                    database.createObjectStore('inspections', { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => {
                db = e.target.result;
                resolve(db);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function dbPut(storeName, data) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).put(data);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    function dbGetAll(storeName) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function dbGet(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function dbDelete(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    // ----------------------------------------------------------
    // State
    // ----------------------------------------------------------
    let currentInspectionId = null;
    let currentPhotoIndex = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let recTimerInterval = null;

    // Navigation stack for back button
    const navStack = [];

    // ----------------------------------------------------------
    // DOM References
    // ----------------------------------------------------------
    const $ = (sel) => document.querySelector(sel);
    const headerTitle = $('#header-title');
    const btnBack = $('#btn-back');

    // Screens
    const screenList = $('#screen-list');
    const screenForm = $('#screen-form');
    const screenDetail = $('#screen-detail');
    const screenPhoto = $('#screen-photo');
    const screenOffice = $('#screen-office');
    const screenRecords = $('#screen-records');

    // ----------------------------------------------------------
    // Navigation
    // ----------------------------------------------------------
    function showScreen(screen, title, pushNav = true) {
        const screens = document.querySelectorAll('.screen');
        const currentScreen = document.querySelector('.screen.active');

        if (pushNav && currentScreen && currentScreen !== screen) {
            navStack.push({
                screen: currentScreen,
                title: headerTitle.textContent,
            });
        }

        screens.forEach((s) => s.classList.remove('active'));
        screen.classList.add('active');
        headerTitle.textContent = title;
        btnBack.classList.toggle('hidden', navStack.length === 0);
        screen.scrollTop = 0;
    }

    btnBack.addEventListener('click', () => {
        if (navStack.length === 0) return;
        const prev = navStack.pop();
        // Refresh content if going back to certain screens
        if (prev.screen === screenList) renderInspectionList();
        if (prev.screen === screenDetail) renderInspectionDetail();
        if (prev.screen === screenOffice) renderOfficePhase();
        showScreen(prev.screen, prev.title, false);
    });

    // ----------------------------------------------------------
    // Screen: Inspection List
    // ----------------------------------------------------------
    async function renderInspectionList() {
        const list = $('#inspection-list');
        const inspections = await dbGetAll('inspections');
        inspections.sort((a, b) => b.createdAt - a.createdAt);

        if (inspections.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">&#128268;</div>
                    <p>Nenhuma inspeção criada.<br>Toque em + para começar.</p>
                </div>`;
            return;
        }

        list.innerHTML = inspections
            .map((ins) => {
                const photoCount = ins.photos ? ins.photos.length : 0;
                const recordCount = ins.photos
                    ? ins.photos.reduce((sum, p) => sum + (p.records ? p.records.length : 0), 0)
                    : 0;
                const date = new Date(ins.createdAt).toLocaleDateString('pt-PT');
                return `
                <div class="inspection-card" data-id="${ins.id}">
                    <button class="btn-delete-inspection" data-id="${ins.id}" title="Eliminar">&times;</button>
                    <div class="card-number">${escHtml(ins.number)}</div>
                    <h3>${escHtml(ins.name)}</h3>
                    <div class="card-meta">${date}${ins.plate ? ' &middot; ' + escHtml(ins.plate) : ''}</div>
                    <div class="card-stats">
                        <span>${photoCount} foto${photoCount !== 1 ? 's' : ''}</span>
                        <span>${recordCount} registo${recordCount !== 1 ? 's' : ''}</span>
                    </div>
                </div>`;
            })
            .join('');

        // Click handlers
        list.querySelectorAll('.inspection-card').forEach((card) => {
            card.addEventListener('click', (e) => {
                if (e.target.classList.contains('btn-delete-inspection')) return;
                currentInspectionId = card.dataset.id;
                renderInspectionDetail();
            });
        });

        list.querySelectorAll('.btn-delete-inspection').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                showDeleteModal('Eliminar esta inspeção e todos os seus dados?', async () => {
                    await dbDelete('inspections', btn.dataset.id);
                    renderInspectionList();
                });
            });
        });
    }

    // ----------------------------------------------------------
    // Screen: New Inspection Form
    // ----------------------------------------------------------
    $('#btn-new-inspection').addEventListener('click', () => {
        $('#inspection-form').reset();
        $('#inp-lat').value = '';
        $('#inp-lng').value = '';
        showScreen(screenForm, 'Nova Inspeção');
    });

    $('#btn-gps').addEventListener('click', () => {
        const btn = $('#btn-gps');
        btn.textContent = 'A obter...';
        btn.disabled = true;
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                $('#inp-lat').value = pos.coords.latitude.toFixed(6);
                $('#inp-lng').value = pos.coords.longitude.toFixed(6);
                btn.textContent = 'Obter GPS';
                btn.disabled = false;
            },
            (err) => {
                alert('Erro ao obter GPS: ' + err.message);
                btn.textContent = 'Obter GPS';
                btn.disabled = false;
            },
            { enableHighAccuracy: true, timeout: 15000 }
        );
    });

    $('#inspection-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const inspection = {
            id: 'insp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            name: $('#inp-name').value.trim(),
            number: $('#inp-number').value.trim(),
            plate: $('#inp-plate').value.trim(),
            lat: $('#inp-lat').value,
            lng: $('#inp-lng').value,
            createdAt: Date.now(),
            photos: [],
        };
        await dbPut('inspections', inspection);
        currentInspectionId = inspection.id;
        // Remove form from nav stack and go to detail
        navStack.pop();
        renderInspectionDetail();
    });

    // ----------------------------------------------------------
    // Screen: Inspection Detail
    // ----------------------------------------------------------
    async function renderInspectionDetail() {
        const ins = await dbGet('inspections', currentInspectionId);
        if (!ins) return;

        $('#detail-title').textContent = ins.name;
        const meta = [ins.number];
        if (ins.plate) meta.push(ins.plate);
        if (ins.lat && ins.lng) meta.push(`GPS: ${ins.lat}, ${ins.lng}`);
        $('#detail-info').textContent = meta.join(' · ');

        renderPhotoGrid(ins);
        showScreen(screenDetail, ins.number);
    }

    function renderPhotoGrid(ins) {
        const grid = $('#photo-grid');
        if (!ins.photos || ins.photos.length === 0) {
            grid.innerHTML = '<div class="empty-state"><p>Sem fotos ainda.<br>Tire a primeira foto.</p></div>';
            return;
        }

        grid.innerHTML = ins.photos
            .map((photo, i) => {
                const audioCount = photo.audios ? photo.audios.length : 0;
                return `
                <div class="photo-thumb" data-index="${i}">
                    <img src="${photo.dataUrl}" alt="Foto ${i + 1}">
                    <span class="photo-badge">${audioCount} aud.</span>
                    <button class="btn-delete-photo" data-index="${i}">&times;</button>
                </div>`;
            })
            .join('');

        grid.querySelectorAll('.photo-thumb').forEach((thumb) => {
            thumb.addEventListener('click', (e) => {
                if (e.target.classList.contains('btn-delete-photo')) return;
                currentPhotoIndex = parseInt(thumb.dataset.index);
                renderPhotoDetail();
            });
        });

        grid.querySelectorAll('.btn-delete-photo').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                showDeleteModal('Eliminar esta foto e os seus áudios?', async () => {
                    const ins = await dbGet('inspections', currentInspectionId);
                    ins.photos.splice(idx, 1);
                    await dbPut('inspections', ins);
                    renderPhotoGrid(ins);
                });
            });
        });
    }

    // Camera
    const cameraInput = $('#camera-input');
    $('#btn-take-photo').addEventListener('click', () => cameraInput.click());

    cameraInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const dataUrl = await readFileAsDataUrl(file);
        const ins = await dbGet('inspections', currentInspectionId);
        ins.photos.push({ dataUrl, audios: [], records: [] });
        await dbPut('inspections', ins);
        renderPhotoGrid(ins);
        cameraInput.value = '';
    });

    // Office phase button
    $('#btn-office-phase').addEventListener('click', () => {
        renderOfficePhase();
    });

    // ----------------------------------------------------------
    // Screen: Photo Detail (audios)
    // ----------------------------------------------------------
    async function renderPhotoDetail() {
        const ins = await dbGet('inspections', currentInspectionId);
        const photo = ins.photos[currentPhotoIndex];
        if (!photo) return;

        $('#photo-preview').src = photo.dataUrl;
        const audioCount = photo.audios ? photo.audios.length : 0;
        $('#audio-count').textContent = audioCount;

        // Audio list
        const audioList = $('#audio-list');
        audioList.innerHTML = (photo.audios || [])
            .map(
                (aud, i) => `
            <div class="audio-item">
                <audio controls src="${aud.dataUrl}"></audio>
                <button class="btn-delete-audio" data-index="${i}">&times;</button>
            </div>`
            )
            .join('');

        audioList.querySelectorAll('.btn-delete-audio').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const idx = parseInt(btn.dataset.index);
                const ins = await dbGet('inspections', currentInspectionId);
                ins.photos[currentPhotoIndex].audios.splice(idx, 1);
                await dbPut('inspections', ins);
                renderPhotoDetail();
            });
        });

        // Show/hide record button
        const btnRecord = $('#btn-record');
        btnRecord.classList.toggle('hidden', audioCount >= 3);

        showScreen(screenPhoto, `Foto ${currentPhotoIndex + 1}`);
    }

    // Audio recording
    $('#btn-record').addEventListener('click', startRecording);
    $('#btn-stop-record').addEventListener('click', stopRecording);

    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            mediaRecorder = new MediaRecorder(stream);

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };

            mediaRecorder.onstop = async () => {
                stream.getTracks().forEach((t) => t.stop());
                const blob = new Blob(audioChunks, { type: 'audio/webm' });
                const dataUrl = await blobToDataUrl(blob);

                const ins = await dbGet('inspections', currentInspectionId);
                if (!ins.photos[currentPhotoIndex].audios) {
                    ins.photos[currentPhotoIndex].audios = [];
                }
                ins.photos[currentPhotoIndex].audios.push({ dataUrl });
                await dbPut('inspections', ins);
                renderPhotoDetail();
            };

            mediaRecorder.start();
            $('#btn-record').classList.add('hidden');
            $('#recording-indicator').classList.remove('hidden');

            let seconds = 0;
            recTimerInterval = setInterval(() => {
                seconds++;
                const m = Math.floor(seconds / 60);
                const s = seconds % 60;
                $('#rec-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
            }, 1000);
        } catch (err) {
            alert('Erro ao aceder ao microfone: ' + err.message);
        }
    }

    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        clearInterval(recTimerInterval);
        $('#recording-indicator').classList.add('hidden');
        $('#rec-timer').textContent = '0:00';
    }

    // ----------------------------------------------------------
    // Screen: Office Phase
    // ----------------------------------------------------------
    async function renderOfficePhase() {
        const ins = await dbGet('inspections', currentInspectionId);
        if (!ins) return;

        $('#office-title').textContent = ins.name + ' - Registos';

        const container = $('#office-photos');
        if (!ins.photos || ins.photos.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>Nenhuma foto para processar.</p></div>';
        } else {
            container.innerHTML = ins.photos
                .map((photo, i) => {
                    const audioCount = photo.audios ? photo.audios.length : 0;
                    const recordCount = photo.records ? photo.records.length : 0;
                    return `
                    <div class="office-photo-card" data-index="${i}">
                        <img src="${photo.dataUrl}" alt="Foto ${i + 1}">
                        <div class="office-card-info">
                            <h4>Foto ${i + 1}</h4>
                            <p>${audioCount} áudio${audioCount !== 1 ? 's' : ''}</p>
                            <p>${recordCount} registo${recordCount !== 1 ? 's' : ''}</p>
                        </div>
                    </div>`;
                })
                .join('');

            container.querySelectorAll('.office-photo-card').forEach((card) => {
                card.addEventListener('click', () => {
                    currentPhotoIndex = parseInt(card.dataset.index);
                    renderRecordsScreen();
                });
            });
        }

        showScreen(screenOffice, 'Fase de Escritório');
    }

    // ----------------------------------------------------------
    // Screen: Photo Records
    // ----------------------------------------------------------
    async function renderRecordsScreen() {
        const ins = await dbGet('inspections', currentInspectionId);
        const photo = ins.photos[currentPhotoIndex];
        if (!photo) return;

        $('#records-photo-preview').src = photo.dataUrl;

        // Audio playback
        const audioContainer = $('#records-audio-playback');
        audioContainer.innerHTML = (photo.audios || [])
            .map((aud, i) => `<audio controls src="${aud.dataUrl}"></audio>`)
            .join('');

        // Records list
        renderRecordsList(photo);

        showScreen(screenRecords, `Foto ${currentPhotoIndex + 1} - Registos`);
    }

    function renderRecordsList(photo) {
        const list = $('#records-list');
        const records = photo.records || [];

        if (records.length === 0) {
            list.innerHTML = '<div class="empty-state"><p>Sem registos. Ouça os áudios e adicione registos.</p></div>';
        } else {
            list.innerHTML = records
                .map(
                    (rec, i) => `
                <div class="record-card">
                    <div class="record-actions">
                        <button class="btn-edit-record" data-index="${i}" title="Editar">&#9998;</button>
                        <button class="btn-delete-record" data-index="${i}" title="Eliminar">&times;</button>
                    </div>
                    <div class="record-label">Localização</div>
                    <div class="record-value">${escHtml(rec.location)}</div>
                    <div class="record-label">Anomalia</div>
                    <div class="record-value">${escHtml(rec.anomaly)}</div>
                    <div class="record-label">Trabalho</div>
                    <div class="record-value">${escHtml(rec.work)}</div>
                    ${rec.notes ? `<div class="record-notes">${escHtml(rec.notes)}</div>` : ''}
                </div>`
                )
                .join('');

            list.querySelectorAll('.btn-edit-record').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.index);
                    openRecordModal(records[idx], idx);
                });
            });

            list.querySelectorAll('.btn-delete-record').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.index);
                    showDeleteModal('Eliminar este registo?', async () => {
                        const ins = await dbGet('inspections', currentInspectionId);
                        ins.photos[currentPhotoIndex].records.splice(idx, 1);
                        await dbPut('inspections', ins);
                        renderRecordsList(ins.photos[currentPhotoIndex]);
                    });
                });
            });
        }
    }

    // ----------------------------------------------------------
    // Record Modal
    // ----------------------------------------------------------
    let editingRecordIndex = null;

    function populateSelect(selectEl, options) {
        const current = selectEl.value;
        selectEl.innerHTML = '<option value="">Selecionar...</option>';
        options.forEach((opt) => {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            selectEl.appendChild(o);
        });
        if (current) selectEl.value = current;
    }

    function openRecordModal(record, index) {
        editingRecordIndex = index !== undefined ? index : null;
        $('#modal-record-title').textContent = editingRecordIndex !== null ? 'Editar Registo' : 'Novo Registo';

        populateSelect($('#rec-location'), LOCATIONS);
        populateSelect($('#rec-anomaly'), ANOMALIES);
        populateSelect($('#rec-work'), WORKS);

        if (record) {
            $('#rec-location').value = record.location || '';
            $('#rec-anomaly').value = record.anomaly || '';
            $('#rec-work').value = record.work || '';
            $('#rec-notes').value = record.notes || '';
        } else {
            $('#record-form').reset();
        }

        $('#modal-record').classList.remove('hidden');
    }

    $('#btn-add-record').addEventListener('click', () => openRecordModal(null));
    $('#btn-cancel-record').addEventListener('click', () => $('#modal-record').classList.add('hidden'));

    $('#record-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const record = {
            location: $('#rec-location').value,
            anomaly: $('#rec-anomaly').value,
            work: $('#rec-work').value,
            notes: $('#rec-notes').value.trim(),
        };

        const ins = await dbGet('inspections', currentInspectionId);
        const photo = ins.photos[currentPhotoIndex];
        if (!photo.records) photo.records = [];

        if (editingRecordIndex !== null) {
            photo.records[editingRecordIndex] = record;
        } else {
            photo.records.push(record);
        }

        await dbPut('inspections', ins);
        $('#modal-record').classList.add('hidden');
        renderRecordsList(photo);
    });

    // ----------------------------------------------------------
    // Delete Confirmation Modal
    // ----------------------------------------------------------
    let deleteCallback = null;

    function showDeleteModal(message, onConfirm) {
        $('#delete-message').textContent = message;
        deleteCallback = onConfirm;
        $('#modal-delete').classList.remove('hidden');
    }

    $('#btn-cancel-delete').addEventListener('click', () => {
        $('#modal-delete').classList.add('hidden');
        deleteCallback = null;
    });

    $('#btn-confirm-delete').addEventListener('click', async () => {
        $('#modal-delete').classList.add('hidden');
        if (deleteCallback) {
            await deleteCallback();
            deleteCallback = null;
        }
    });

    // ----------------------------------------------------------
    // Utilities
    // ----------------------------------------------------------
    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function escHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    // ----------------------------------------------------------
    // Init
    // ----------------------------------------------------------
    async function init() {
        await openDB();
        renderInspectionList();
        showScreen(screenList, 'Inspeções OA', false);

        // Register service worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }
    }

    init();
})();
