// ============================================================
// Inspeções OA - Bridge Inspection PWA
// ============================================================

(function () {
    'use strict';

    // ----------------------------------------------------------
    // Settings (persisted in localStorage)
    // ----------------------------------------------------------
    const SETTINGS_KEY = 'inspecoesoa_settings';

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) return JSON.parse(raw);
        } catch (_) {}
        return { locations: [], anomalies: [], works: [], apiKey: '', aiProvider: 'openai' };
    }

    function saveSettings(settings) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    let settings = loadSettings();

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

    const navStack = [];

    // ----------------------------------------------------------
    // DOM References
    // ----------------------------------------------------------
    const $ = (sel) => document.querySelector(sel);
    const headerTitle = $('#header-title');
    const btnBack = $('#btn-back');
    const btnSettings = $('#btn-settings');

    const screenList = $('#screen-list');
    const screenForm = $('#screen-form');
    const screenDetail = $('#screen-detail');
    const screenPhoto = $('#screen-photo');
    const screenOffice = $('#screen-office');
    const screenRecords = $('#screen-records');
    const screenSettings = $('#screen-settings');

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
        if (prev.screen === screenList) renderInspectionList();
        if (prev.screen === screenDetail) renderInspectionDetail();
        if (prev.screen === screenOffice) renderOfficePhase();
        if (prev.screen === screenRecords) renderRecordsScreen();
        showScreen(prev.screen, prev.title, false);
    });

    // ----------------------------------------------------------
    // Screen: Settings
    // ----------------------------------------------------------
    btnSettings.addEventListener('click', () => {
        renderSettingsScreen();
    });

    function renderSettingsScreen() {
        // API key
        $('#settings-api-key').value = settings.apiKey || '';

        // AI provider
        $('#settings-ai-provider').value = settings.aiProvider || 'openai';

        // Lists
        $('#settings-locations').value = (settings.locations || []).join('\n');
        $('#settings-anomalies').value = (settings.anomalies || []).join('\n');
        $('#settings-works').value = (settings.works || []).join('\n');

        showScreen(screenSettings, 'Definições');
    }

    $('#settings-form').addEventListener('submit', (e) => {
        e.preventDefault();
        settings.apiKey = $('#settings-api-key').value.trim();
        settings.aiProvider = $('#settings-ai-provider').value;
        settings.locations = parseTextareaList($('#settings-locations').value);
        settings.anomalies = parseTextareaList($('#settings-anomalies').value);
        settings.works = parseTextareaList($('#settings-works').value);
        saveSettings(settings);
        // Go back
        if (navStack.length > 0) {
            const prev = navStack.pop();
            showScreen(prev.screen, prev.title, false);
        }
    });

    function parseTextareaList(text) {
        return text
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }

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

        const btnRecord = $('#btn-record');
        btnRecord.classList.toggle('hidden', audioCount >= 3);

        showScreen(screenPhoto, `Foto ${currentPhotoIndex + 1}`);
    }

    // Audio recording
    let speechRecognition = null;
    let liveTranscript = '';

    $('#btn-record').addEventListener('click', startRecording);
    $('#btn-stop-record').addEventListener('click', stopRecording);

    function getRecorderMimeType() {
        // Safari/iOS needs mp4, Chrome/Android supports webm
        const types = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) return type;
        }
        return '';
    }

    function startSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return null;

        const recognition = new SpeechRecognition();
        recognition.lang = 'pt-PT';
        recognition.continuous = true;
        recognition.interimResults = true;

        liveTranscript = '';
        let finalTranscript = '';

        recognition.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const text = e.results[i][0].transcript;
                if (e.results[i].isFinal) {
                    finalTranscript += text + ' ';
                } else {
                    interim = text;
                }
            }
            liveTranscript = finalTranscript + interim;
            const liveEl = $('#live-transcript');
            if (liveEl) liveEl.textContent = liveTranscript || 'A ouvir...';
        };

        recognition.onerror = () => {}; // silently ignore
        recognition.onend = () => {
            // Restart if still recording (speech recognition auto-stops)
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                try { recognition.start(); } catch (_) {}
            }
        };

        try {
            recognition.start();
        } catch (_) {}
        return recognition;
    }

    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            const mimeType = getRecorderMimeType();
            const options = mimeType ? { mimeType } : {};
            mediaRecorder = new MediaRecorder(stream, options);

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };

            mediaRecorder.onstop = async () => {
                stream.getTracks().forEach((t) => t.stop());
                // Stop speech recognition
                if (speechRecognition) {
                    try { speechRecognition.stop(); } catch (_) {}
                    speechRecognition = null;
                }
                const actualType = mimeType || 'audio/webm';
                const blob = new Blob(audioChunks, { type: actualType });
                const dataUrl = await blobToDataUrl(blob);

                const audioEntry = { dataUrl };
                // Save local transcription if available
                if (liveTranscript && liveTranscript.trim().length > 0) {
                    audioEntry.transcription = liveTranscript.trim();
                }

                const ins = await dbGet('inspections', currentInspectionId);
                if (!ins.photos[currentPhotoIndex].audios) {
                    ins.photos[currentPhotoIndex].audios = [];
                }
                ins.photos[currentPhotoIndex].audios.push(audioEntry);
                await dbPut('inspections', ins);
                liveTranscript = '';
                renderPhotoDetail();
            };

            mediaRecorder.start();

            // Start local speech recognition in parallel
            speechRecognition = startSpeechRecognition();

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
        if (speechRecognition) {
            try { speechRecognition.stop(); } catch (_) {}
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
                    const hasTranscription = photo.audios && photo.audios.some((a) => a.transcription);
                    return `
                    <div class="office-photo-card" data-index="${i}">
                        <img src="${photo.dataUrl}" alt="Foto ${i + 1}">
                        <div class="office-card-info">
                            <h4>Foto ${i + 1}</h4>
                            <p>${audioCount} áudio${audioCount !== 1 ? 's' : ''}${hasTranscription ? ' (transcrito)' : ''}</p>
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
    // Screen: Photo Records (with AI)
    // ----------------------------------------------------------
    async function renderRecordsScreen() {
        const ins = await dbGet('inspections', currentInspectionId);
        const photo = ins.photos[currentPhotoIndex];
        if (!photo) return;

        $('#records-photo-preview').src = photo.dataUrl;

        // Audio playback with transcriptions
        const audioContainer = $('#records-audio-playback');
        audioContainer.innerHTML = (photo.audios || [])
            .map(
                (aud, i) => `
            <div class="audio-playback-item">
                <div class="audio-playback-header">
                    <span class="audio-label">Áudio ${i + 1}</span>
                </div>
                <audio controls src="${aud.dataUrl}"></audio>
                ${aud.transcription ? `<div class="transcription-text">${escHtml(aud.transcription)}</div>` : ''}
            </div>`
            )
            .join('');

        // AI buttons
        const hasAudios = photo.audios && photo.audios.length > 0;
        const hasApiKey = settings.apiKey && settings.apiKey.length > 0;
        const hasLists = settings.locations.length > 0 || settings.anomalies.length > 0 || settings.works.length > 0;
        const allTranscribed = hasAudios && photo.audios.every((a) => a.transcription);

        const btnTranscribe = $('#btn-ai-transcribe');
        const btnExtract = $('#btn-ai-extract');

        btnTranscribe.classList.toggle('hidden', !hasAudios || !hasApiKey);
        btnExtract.classList.toggle('hidden', !allTranscribed || !hasApiKey || !hasLists);

        if (!hasApiKey) {
            $('#ai-status').textContent = 'Configure a chave API nas Definições para usar IA.';
            $('#ai-status').classList.remove('hidden');
        } else if (!hasLists) {
            $('#ai-status').textContent = 'Configure as listas nas Definições para extrair registos com IA.';
            $('#ai-status').classList.remove('hidden');
        } else {
            $('#ai-status').classList.add('hidden');
        }

        renderRecordsList(photo);
        showScreen(screenRecords, `Foto ${currentPhotoIndex + 1} - Registos`);
    }

    function renderRecordsList(photo) {
        const list = $('#records-list');
        const records = photo.records || [];

        if (records.length === 0) {
            list.innerHTML = '<div class="empty-state"><p>Sem registos. Use a IA para extrair registos dos áudios ou adicione manualmente.</p></div>';
        } else {
            list.innerHTML = records
                .map(
                    (rec, i) => `
                <div class="record-card${rec.aiGenerated ? ' ai-generated' : ''}">
                    <div class="record-actions">
                        <button class="btn-edit-record" data-index="${i}" title="Editar">&#9998;</button>
                        <button class="btn-delete-record" data-index="${i}" title="Eliminar">&times;</button>
                    </div>
                    ${rec.aiGenerated ? '<div class="ai-badge">IA</div>' : ''}
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
    // AI: Transcribe Audios (Whisper)
    // ----------------------------------------------------------
    $('#btn-ai-transcribe').addEventListener('click', async () => {
        const btn = $('#btn-ai-transcribe');
        btn.disabled = true;
        btn.textContent = 'A transcrever...';

        try {
            const ins = await dbGet('inspections', currentInspectionId);
            const photo = ins.photos[currentPhotoIndex];

            for (let i = 0; i < photo.audios.length; i++) {
                const aud = photo.audios[i];
                if (aud.transcription) continue; // already transcribed

                btn.textContent = `A transcrever áudio ${i + 1}/${photo.audios.length}...`;
                const transcription = await transcribeAudio(aud.dataUrl);
                aud.transcription = transcription;
            }

            await dbPut('inspections', ins);
            renderRecordsScreen();
        } catch (err) {
            alert('Erro na transcrição: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Transcrever Áudios com IA';
        }
    });

    async function transcribeAudio(audioDataUrl) {
        const blob = dataUrlToBlob(audioDataUrl);
        const formData = new FormData();
        formData.append('file', blob, 'audio.webm');
        formData.append('model', 'whisper-1');
        formData.append('language', 'pt');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${settings.apiKey}`,
            },
            body: formData,
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Whisper API erro ${response.status}: ${err}`);
        }

        const data = await response.json();
        return data.text;
    }

    // ----------------------------------------------------------
    // AI: Extract Records from Transcriptions
    // ----------------------------------------------------------
    $('#btn-ai-extract').addEventListener('click', async () => {
        const btn = $('#btn-ai-extract');
        btn.disabled = true;
        btn.textContent = 'A analisar com IA...';

        try {
            const ins = await dbGet('inspections', currentInspectionId);
            const photo = ins.photos[currentPhotoIndex];

            const transcriptions = photo.audios
                .map((a, i) => `Áudio ${i + 1}: ${a.transcription}`)
                .join('\n\n');

            const records = await extractRecords(transcriptions);

            if (!photo.records) photo.records = [];
            records.forEach((rec) => {
                rec.aiGenerated = true;
                photo.records.push(rec);
            });

            await dbPut('inspections', ins);
            renderRecordsScreen();
        } catch (err) {
            alert('Erro na extração: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Extrair Registos com IA';
        }
    });

    async function extractRecords(transcriptionText) {
        const systemPrompt = `És um assistente especializado em inspeções de obras de arte (pontes).
A partir de transcrições de áudio feitas durante uma inspeção, deves extrair registos estruturados.

Cada registo deve ter:
- location: a localização do elemento inspecionado (DEVE ser uma das opções da lista fornecida, ou a mais próxima)
- anomaly: a anomalia observada (DEVE ser uma das opções da lista fornecida, ou a mais próxima)
- work: o trabalho recomendado (DEVE ser uma das opções da lista fornecida, ou a mais próxima)
- notes: observações adicionais relevantes mencionadas no áudio

LISTAS DISPONÍVEIS:

Localizações:
${settings.locations.map((l) => '- ' + l).join('\n')}

Anomalias:
${settings.anomalies.map((a) => '- ' + a).join('\n')}

Trabalhos:
${settings.works.map((w) => '- ' + w).join('\n')}

REGRAS:
- Extrai TODOS os registos distintos mencionados nas transcrições
- Cada combinação localização+anomalia deve ser um registo separado
- Usa EXATAMENTE os valores das listas (não inventes novos)
- Se algo mencionado não corresponder a nenhum item da lista, usa o mais próximo e explica nas notas
- Responde APENAS com JSON válido, um array de objetos`;

        const userPrompt = `Transcrições dos áudios desta foto de inspeção:\n\n${transcriptionText}\n\nExtrai os registos em formato JSON.`;

        const provider = settings.aiProvider || 'openai';
        let apiUrl, headers, body;

        if (provider === 'anthropic') {
            apiUrl = 'https://api.anthropic.com/v1/messages';
            headers = {
                'Content-Type': 'application/json',
                'x-api-key': settings.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            };
            body = JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2048,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
            });
        } else {
            apiUrl = 'https://api.openai.com/v1/chat/completions';
            headers = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${settings.apiKey}`,
            };
            body = JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.2,
                response_format: { type: 'json_object' },
            });
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body,
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`API erro ${response.status}: ${err}`);
        }

        const data = await response.json();

        let text;
        if (provider === 'anthropic') {
            text = data.content[0].text;
        } else {
            text = data.choices[0].message.content;
        }

        // Parse JSON from response (handle markdown code blocks)
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            throw new Error('A IA não devolveu registos válidos.');
        }

        const records = JSON.parse(jsonMatch[0]);
        return records.map((r) => ({
            location: r.location || '',
            anomaly: r.anomaly || '',
            work: r.work || '',
            notes: r.notes || '',
        }));
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

        populateSelect($('#rec-location'), settings.locations);
        populateSelect($('#rec-anomaly'), settings.anomalies);
        populateSelect($('#rec-work'), settings.works);

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

    function dataUrlToBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)[1];
        const byteStr = atob(parts[1]);
        const ab = new ArrayBuffer(byteStr.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteStr.length; i++) {
            ia[i] = byteStr.charCodeAt(i);
        }
        return new Blob([ab], { type: mime });
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

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }
    }

    init();
})();
