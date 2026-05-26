/**
 * Answer Sync — Content Script
 * Core engine: question detection, sidebar review panel, auto-fill engine.
 * Injected into every page via content_scripts in manifest.json.
 */

(() => {
    // Prevent double injection
    if (window.__answerSyncLoaded) return;
    window.__answerSyncLoaded = true;

    const BACKEND_URL = 'https://answer-sync-web.vercel.app';
    const ALLOWED_ORIGINS = ['http://localhost:3000', BACKEND_URL];

    // ============================================================
    // 1. AUTH: Listen for token from website login page
    // ============================================================
    window.addEventListener('message', (event) => {
        if (!ALLOWED_ORIGINS.includes(event.origin)) return;
        if (event.data && event.data.type === 'ANSWER_SYNC_AUTH') {
            const { token, user } = event.data;
            if (token && user) {
                chrome.storage.local.set({
                    authToken: token,
                    userEmail: user.email,
                    userTier: user.tier || 'free',
                    dailyCreditsUsed: user.dailyCreditsUsed || 0,
                    dailyCreditLimit: user.dailyCreditLimit || 20
                }, () => {
                    console.log('Answer Sync: Authenticated successfully.');
                    chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED' }).catch(() => {});
                });
            }
        }
    });

    // ============================================================
    // 2. MESSAGE HANDLING from popup & background
    // ============================================================
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'PING') {
            sendResponse({ pong: true });
            return false;
        }

        if (request.type === 'GET_QUESTION_COUNT') {
            const questions = scanQuestions();
            sendResponse({ count: questions.length });
            return false;
        }

        if (request.type === 'SCAN_AND_REVIEW') {
            handleScanAndReview(request.authToken)
                .then(result => sendResponse(result))
                .catch(err => sendResponse({ error: err.message }));
            return true; // async
        }

        if (request.type === 'SCAN_AND_AUTOFILL') {
            handleScanAndAutoFill(request.authToken)
                .then(result => sendResponse(result))
                .catch(err => sendResponse({ error: err.message }));
            return true; // async
        }
    });

    // ============================================================
    // 3. QUESTION DETECTION ENGINE
    // ============================================================

    function scanQuestions() {
        const questions = [];
        const processedRadioNames = new Set();
        const processedCheckboxNames = new Set();
        let questionId = 0;

        // --- Text inputs ---
        document.querySelectorAll('input[type="text"], input[type="email"], input[type="number"], input[type="date"], input:not([type])').forEach(el => {
            if (shouldSkip(el)) return;
            // input:not([type]) defaults to text
            if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'password' || el.type === 'file' || el.type === 'image' || el.type === 'reset' || el.type === 'search') return;

            const qText = extractQuestionText(el);
            if (!qText || qText.length < 3) return;

            questions.push({
                id: `q_${questionId++}`,
                type: el.type || 'text',
                questionText: qText,
                options: [],
                element: el,
                allElements: [el],
                context: getContext(el)
            });
        });

        // --- Textareas ---
        document.querySelectorAll('textarea').forEach(el => {
            if (shouldSkip(el)) return;
            const qText = extractQuestionText(el);
            if (!qText || qText.length < 3) return;

            questions.push({
                id: `q_${questionId++}`,
                type: 'textarea',
                questionText: qText,
                options: [],
                element: el,
                allElements: [el],
                context: getContext(el)
            });
        });

        // --- Radio buttons (grouped by name) ---
        document.querySelectorAll('input[type="radio"]').forEach(el => {
            if (shouldSkip(el)) return;
            const name = el.name || el.id || '';
            if (processedRadioNames.has(name)) return;
            processedRadioNames.add(name);

            const siblings = name
                ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`))
                : [el];

            const qText = extractQuestionText(el);
            if (!qText || qText.length < 3) return;

            const options = siblings.map(sib => getInputLabel(sib)).filter(Boolean);

            questions.push({
                id: `q_${questionId++}`,
                type: 'radio',
                questionText: qText,
                options,
                element: el,
                allElements: siblings,
                context: `Available options: ${options.join(' || ')}`
            });
        });

        // --- Checkboxes (grouped by name) ---
        document.querySelectorAll('input[type="checkbox"]').forEach(el => {
            if (shouldSkip(el)) return;
            const name = el.name || '';
            // Group by name if available, otherwise treat individually
            if (name && processedCheckboxNames.has(name)) return;
            if (name) processedCheckboxNames.add(name);

            const siblings = name
                ? Array.from(document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`))
                : [el];

            // Skip if this looks like a single toggle (e.g. "I agree" checkbox)
            if (siblings.length === 1) {
                const label = getInputLabel(el);
                if (!label || label.length < 5) return;
            }

            const qText = extractQuestionText(el);
            if (!qText || qText.length < 3) return;

            const options = siblings.map(sib => getInputLabel(sib)).filter(Boolean);

            questions.push({
                id: `q_${questionId++}`,
                type: 'checkbox',
                questionText: qText,
                options,
                element: el,
                allElements: siblings,
                context: `Available options (select all that apply): ${options.join(' || ')}`
            });
        });

        // --- Select dropdowns ---
        document.querySelectorAll('select').forEach(el => {
            if (shouldSkip(el)) return;
            const qText = extractQuestionText(el);
            if (!qText || qText.length < 3) return;

            const options = Array.from(el.options)
                .filter(opt => opt.value && opt.value !== '' && !opt.disabled)
                .map(opt => opt.text.trim())
                .filter(Boolean);

            if (options.length === 0) return;

            questions.push({
                id: `q_${questionId++}`,
                type: 'select',
                questionText: qText,
                options,
                element: el,
                allElements: [el],
                context: `Available options: ${options.join(' || ')}`
            });
        });

        // --- Contenteditable fields ---
        document.querySelectorAll('[contenteditable="true"]').forEach(el => {
            if (shouldSkip(el)) return;
            if (el.closest('.answersync-sidebar')) return; // skip our own UI
            const qText = extractQuestionText(el);
            if (!qText || qText.length < 3) return;

            questions.push({
                id: `q_${questionId++}`,
                type: 'contenteditable',
                questionText: qText,
                options: [],
                element: el,
                allElements: [el],
                context: getContext(el)
            });
        });

        return questions;
    }

    function shouldSkip(el) {
        if (!el || el.offsetParent === null) return true; // hidden
        if (el.disabled) return true;
        if (el.readOnly) return true;
        if (el.closest('.answersync-sidebar')) return true; // our own UI
        if (el.closest('.answersync-button-container')) return true;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;

        return false;
    }

    // ============================================================
    // 4. QUESTION TEXT EXTRACTION (Priority Cascade)
    // ============================================================

    function extractQuestionText(el) {
        let text = '';

        // 1. aria-label
        if (el.getAttribute('aria-label')) {
            text = el.getAttribute('aria-label').trim();
            if (text) return cleanText(text);
        }

        // 2. aria-labelledby
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl) {
                text = labelEl.innerText.trim();
                if (text) return cleanText(text);
            }
        }

        // 3. Associated <label> via for= attribute
        if (el.id) {
            const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (label) {
                text = label.innerText.trim();
                if (text) return cleanText(text);
            }
        }

        // 4. Parent <label> wrapper
        const parentLabel = el.closest('label');
        if (parentLabel) {
            // Get text excluding the input itself
            const clone = parentLabel.cloneNode(true);
            clone.querySelectorAll('input, select, textarea').forEach(inp => inp.remove());
            text = clone.innerText.trim();
            if (text) return cleanText(text);
        }

        // 5. Closest <legend> in <fieldset>
        const fieldset = el.closest('fieldset');
        if (fieldset) {
            const legend = fieldset.querySelector('legend');
            if (legend) {
                text = legend.innerText.trim();
                if (text) return cleanText(text);
            }
        }

        // 6. For radio/checkbox: look for a question heading/label near the group
        if (el.type === 'radio' || el.type === 'checkbox') {
            const groupParent = el.closest('fieldset') || el.closest('[role="radiogroup"]') || el.closest('[role="group"]');
            if (groupParent) {
                // Look for a heading or bold text
                const heading = groupParent.querySelector('h1, h2, h3, h4, h5, h6, legend, .question-text, [class*="question"], [class*="label"]');
                if (heading) {
                    text = heading.innerText.trim();
                    if (text) return cleanText(text);
                }
            }
        }

        // 7. Walk up parents looking for question text with "?"
        let parent = el.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
            // Check for heading siblings or previous siblings
            const prevSibling = parent.previousElementSibling;
            if (prevSibling) {
                const tagName = prevSibling.tagName.toLowerCase();
                if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'p', 'span', 'div', 'legend'].includes(tagName)) {
                    const sibText = prevSibling.innerText.trim();
                    if (sibText && sibText.length > 3 && sibText.length < 500) {
                        return cleanText(sibText);
                    }
                }
            }

            // Look at parent's own text that might contain "?"
            const parentText = parent.innerText ? parent.innerText.trim() : '';
            if (parentText.includes('?') && parentText.length < 500) {
                const lines = parentText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                const qLine = lines.find(l => l.includes('?'));
                if (qLine && qLine.length > 5 && qLine.length < 300) return cleanText(qLine);
            }

            parent = parent.parentElement;
        }

        // 8. Previous sibling text node
        if (el.previousSibling && el.previousSibling.nodeType === Node.TEXT_NODE) {
            text = el.previousSibling.textContent.trim();
            if (text && text.length > 3) return cleanText(text);
        }

        // 9. Previous element sibling
        if (el.previousElementSibling) {
            text = el.previousElementSibling.innerText?.trim() || '';
            if (text && text.length > 3 && text.length < 300) return cleanText(text);
        }

        // 10. Placeholder
        if (el.placeholder) {
            text = el.placeholder.trim();
            if (text.length > 3) return cleanText(text);
        }

        // 11. title attribute
        if (el.title) {
            text = el.title.trim();
            if (text.length > 3) return cleanText(text);
        }

        return null;
    }

    function getInputLabel(el) {
        // For a single radio/checkbox, get its label text
        if (el.id) {
            const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (label) return label.innerText.trim();
        }
        const parentLabel = el.closest('label');
        if (parentLabel) {
            const clone = parentLabel.cloneNode(true);
            clone.querySelectorAll('input').forEach(inp => inp.remove());
            const t = clone.innerText.trim();
            if (t) return t;
        }
        if (el.nextSibling && el.nextSibling.nodeType === Node.TEXT_NODE) {
            const t = el.nextSibling.textContent.trim();
            if (t) return t;
        }
        if (el.nextElementSibling) {
            const t = el.nextElementSibling.innerText?.trim();
            if (t && t.length < 200) return t;
        }
        return el.value || '';
    }

    function cleanText(text) {
        // Get the first meaningful line, prefer lines with "?"
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return null;
        const qLine = lines.find(l => l.includes('?'));
        const result = qLine || lines[0];
        return result.length > 300 ? result.substring(0, 300) + '...' : result;
    }

    function getContext(el) {
        // Get surrounding paragraph text for extra AI context
        let parent = el.parentElement;
        for (let i = 0; i < 3 && parent; i++) {
            const text = parent.innerText?.trim() || '';
            if (text.length > 20 && text.length < 1000) {
                return text.substring(0, 500);
            }
            parent = parent.parentElement;
        }
        return '';
    }

    // ============================================================
    // 5. FUZZY TEXT MATCHING (for radio/checkbox/select options)
    // ============================================================

    function fuzzyMatch(text1, text2) {
        if (!text1 || !text2) return false;
        const a = text1.toLowerCase().trim();
        const b = text2.toLowerCase().trim();
        if (a === b) return true;
        if (a.includes(b) || b.includes(a)) return true;
        // Remove punctuation and compare
        const cleanA = a.replace(/[^a-z0-9\s]/g, '').trim();
        const cleanB = b.replace(/[^a-z0-9\s]/g, '').trim();
        if (cleanA === cleanB) return true;
        if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;
        return false;
    }

    // ============================================================
    // 6. AUTO-FILL ENGINE
    // ============================================================

    function fillAnswer(questionObj, answerText) {
        if (!answerText) return false;

        try {
            switch (questionObj.type) {
                case 'text':
                case 'email':
                case 'number':
                case 'date':
                    return fillTextInput(questionObj.element, answerText);

                case 'textarea':
                    return fillTextInput(questionObj.element, answerText);

                case 'contenteditable':
                    questionObj.element.innerText = answerText;
                    questionObj.element.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;

                case 'radio':
                    return fillRadio(questionObj.allElements, answerText);

                case 'checkbox':
                    return fillCheckboxes(questionObj.allElements, answerText);

                case 'select':
                    return fillSelect(questionObj.element, answerText);

                default:
                    return false;
            }
        } catch (e) {
            console.error('Answer Sync: Fill error for', questionObj.id, e);
            return false;
        }
    }

    function fillTextInput(el, value) {
        // Use native setter for React/Vue/Angular compatibility
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        )?.set;

        if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, value);
        } else {
            el.value = value;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));

        // Visual feedback
        addFillAnimation(el);
        return true;
    }

    function fillRadio(radioElements, answerText) {
        for (const radio of radioElements) {
            const label = getInputLabel(radio);
            if (fuzzyMatch(label, answerText) || fuzzyMatch(radio.value, answerText)) {
                radio.checked = true;
                radio.dispatchEvent(new Event('input', { bubbles: true }));
                radio.dispatchEvent(new Event('change', { bubbles: true }));
                radio.click();
                addFillAnimation(radio.closest('label') || radio);
                return true;
            }
        }
        return false;
    }

    function fillCheckboxes(checkboxElements, answerText) {
        // answerText could be JSON array or comma-separated
        let selectedOptions = [];
        try {
            selectedOptions = JSON.parse(answerText);
        } catch {
            selectedOptions = answerText.split(',').map(s => s.trim()).filter(Boolean);
        }

        let filled = false;
        for (const cb of checkboxElements) {
            const label = getInputLabel(cb);
            const shouldCheck = selectedOptions.some(opt => fuzzyMatch(label, opt) || fuzzyMatch(cb.value, opt));
            cb.checked = shouldCheck;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            if (shouldCheck) {
                addFillAnimation(cb.closest('label') || cb);
                filled = true;
            }
        }
        return filled;
    }

    function fillSelect(selectEl, answerText) {
        for (const option of selectEl.options) {
            if (fuzzyMatch(option.text, answerText) || fuzzyMatch(option.value, answerText)) {
                selectEl.value = option.value;
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                addFillAnimation(selectEl);
                return true;
            }
        }
        return false;
    }

    function addFillAnimation(el) {
        el.classList.add('answersync-filled');
        setTimeout(() => el.classList.remove('answersync-filled'), 2000);
    }

    // ============================================================
    // 7. SIDEBAR REVIEW PANEL
    // ============================================================

    let sidebarEl = null;

    function createSidebar(questions, answers) {
        removeSidebar();

        sidebarEl = document.createElement('div');
        sidebarEl.className = 'answersync-sidebar';
        sidebarEl.innerHTML = `
            <div class="answersync-sidebar-header">
                <div class="answersync-sidebar-title">
                    <span class="answersync-sidebar-logo">✨</span>
                    Answer Sync Review
                </div>
                <button class="answersync-sidebar-close" id="answersyncClose">&times;</button>
            </div>
            <div class="answersync-sidebar-count">
                Found ${questions.length} question${questions.length !== 1 ? 's' : ''}
            </div>
            <div class="answersync-sidebar-body" id="answersyncBody"></div>
            <div class="answersync-sidebar-footer">
                <button class="answersync-btn-apply-all" id="answersyncApplyAll">
                    ✓ Apply All Selected
                </button>
            </div>
        `;

        document.body.appendChild(sidebarEl);

        // Force reflow then open
        requestAnimationFrame(() => {
            sidebarEl.classList.add('open');
        });

        const body = sidebarEl.querySelector('#answersyncBody');

        // Build Q&A cards
        questions.forEach((q, idx) => {
            const answer = answers.find(a => a.id === q.id);
            const answerText = answer ? answer.answer : 'Could not generate answer';
            const confidence = answer ? answer.confidence : 0;
            const confPct = Math.round((confidence || 0) * 100);
            const confClass = confPct >= 80 ? 'high' : confPct >= 50 ? 'medium' : 'low';

            const card = document.createElement('div');
            card.className = 'answersync-card';
            card.dataset.questionId = q.id;
            card.dataset.skipped = 'false';

            card.innerHTML = `
                <div class="answersync-card-header">
                    <span class="answersync-card-num">Q${idx + 1}</span>
                    <span class="answersync-card-type">${q.type}</span>
                    <span class="answersync-card-conf ${confClass}">${confPct}%</span>
                </div>
                <div class="answersync-card-question">${escapeHtml(q.questionText)}</div>
                ${q.options.length > 0 ? `<div class="answersync-card-options">Options: ${q.options.map(o => escapeHtml(o)).join(' · ')}</div>` : ''}
                <div class="answersync-card-answer">
                    <span class="answersync-card-answer-label">AI Answer:</span>
                    <div class="answersync-card-answer-text" contenteditable="true">${escapeHtml(answerText)}</div>
                </div>
                <div class="answersync-card-actions">
                    <button class="answersync-card-btn apply" data-action="apply">✓ Apply</button>
                    <button class="answersync-card-btn skip" data-action="skip">✗ Skip</button>
                </div>
            `;

            // Hover → highlight element on page
            card.addEventListener('mouseenter', () => {
                highlightElement(q.element, true);
            });
            card.addEventListener('mouseleave', () => {
                highlightElement(q.element, false);
            });

            // Apply single
            card.querySelector('[data-action="apply"]').addEventListener('click', () => {
                const editedAnswer = card.querySelector('.answersync-card-answer-text').innerText.trim();
                const filled = fillAnswer(q, editedAnswer);
                if (filled) {
                    card.classList.add('applied');
                    card.querySelector('[data-action="apply"]').textContent = '✓ Applied';
                }
            });

            // Skip
            card.querySelector('[data-action="skip"]').addEventListener('click', () => {
                const isSkipped = card.dataset.skipped === 'true';
                card.dataset.skipped = isSkipped ? 'false' : 'true';
                card.classList.toggle('skipped', !isSkipped);
                card.querySelector('[data-action="skip"]').textContent = isSkipped ? '✗ Skip' : '↩ Unskip';
            });

            body.appendChild(card);
        });

        // Close button
        sidebarEl.querySelector('#answersyncClose').addEventListener('click', removeSidebar);

        // Apply All
        sidebarEl.querySelector('#answersyncApplyAll').addEventListener('click', () => {
            const cards = body.querySelectorAll('.answersync-card');
            let filledCount = 0;
            cards.forEach(card => {
                if (card.dataset.skipped === 'true' || card.classList.contains('applied')) return;
                const qId = card.dataset.questionId;
                const q = questions.find(q => q.id === qId);
                const editedAnswer = card.querySelector('.answersync-card-answer-text').innerText.trim();
                if (q && fillAnswer(q, editedAnswer)) {
                    card.classList.add('applied');
                    card.querySelector('[data-action="apply"]').textContent = '✓ Applied';
                    filledCount++;
                }
            });
        });
    }

    function removeSidebar() {
        if (sidebarEl) {
            sidebarEl.classList.remove('open');
            setTimeout(() => {
                sidebarEl?.remove();
                sidebarEl = null;
            }, 300);
        }
    }

    function highlightElement(el, on) {
        if (!el) return;
        if (on) {
            el.classList.add('answersync-highlight');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            el.classList.remove('answersync-highlight');
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ============================================================
    // 8. SCAN & REVIEW Handler
    // ============================================================

    async function handleScanAndReview(authToken) {
        const questions = scanQuestions();
        if (questions.length === 0) {
            return { error: 'No questions detected on this page.' };
        }

        // Prepare questions for API (without DOM references)
        const apiQuestions = questions.map(q => ({
            id: q.id,
            type: q.type,
            questionText: q.questionText,
            options: q.options,
            context: q.context
        }));

        // Call background to solve
        const result = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'SOLVE_BATCH',
                questions: apiQuestions,
                authToken
            }, resolve);
        });

        if (result.error) {
            return { error: result.error };
        }

        // Open sidebar with results
        createSidebar(questions, result.answers || []);
        return { success: true, count: questions.length };
    }

    // ============================================================
    // 9. SCAN & AUTO-FILL Handler
    // ============================================================

    async function handleScanAndAutoFill(authToken) {
        const questions = scanQuestions();
        if (questions.length === 0) {
            return { error: 'No questions detected on this page.' };
        }

        const apiQuestions = questions.map(q => ({
            id: q.id,
            type: q.type,
            questionText: q.questionText,
            options: q.options,
            context: q.context
        }));

        const result = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'SOLVE_BATCH',
                questions: apiQuestions,
                authToken
            }, resolve);
        });

        if (result.error) {
            return { error: result.error };
        }

        // Auto-fill all answers
        let filledCount = 0;
        const answers = result.answers || [];
        for (const q of questions) {
            const answer = answers.find(a => a.id === q.id);
            if (answer && answer.answer) {
                const filled = fillAnswer(q, answer.answer);
                if (filled) filledCount++;
            }
        }

        return { filled: filledCount, total: questions.length };
    }

})();
