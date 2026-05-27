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
            if (lastDetectedQuestions.length > 0) {
                sendResponse({ count: lastDetectedQuestions.length });
                debouncedRescan();
            } else {
                smartScan().then(questions => {
                    if (questions.length > 0) {
                        sendResponse({ count: questions.length });
                    } else {
                        // DOM found nothing — count questions from visible text
                        const textCount = countQuestionsFromText();
                        sendResponse({ count: textCount, aiMode: textCount > 0 });
                    }
                });
            }
            return true;
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

        if (request.type === 'TOGGLE_AUTOFILL') {
            autoFillActive = request.active;
            if (request.authToken) {
                autoFillAuthToken = request.authToken;
                // Also store for persistence across page loads
                chrome.storage.local.set({ autoFillAuthToken: request.authToken });
            }
            console.log(`%c[Answer Sync] Auto-fill ${autoFillActive ? 'ACTIVATED' : 'DEACTIVATED'}`, 'color: #4caf50; font-weight: bold; font-size: 14px');
            if (autoFillActive) {
                runAutoFillCycle();
            }
            sendResponse({ ok: true });
            return false;
        }
    });

    // ============================================================
    // PERSISTENT AUTO-FILL ENGINE
    // Runs asynchronously in the background when toggle is ON
    // ============================================================

    let autoFillActive = false;
    let autoFillAuthToken = null;
    let autoFillRunning = false;
    let lastAutoFilledText = ''; // Track what we already filled to avoid repeats

    // Restore auto-fill state on page load
    chrome.storage.local.get(['autoFillActive', 'autoFillAuthToken', 'authToken'], (result) => {
        if (result.autoFillActive) {
            autoFillActive = true;
            autoFillAuthToken = result.autoFillAuthToken || result.authToken;
            console.log('%c[Answer Sync] Auto-fill restored from storage — ACTIVE', 'color: #4caf50; font-weight: bold');
            // Wait for page to load, then start
            setTimeout(() => runAutoFillCycle(), 2000);
        }
    });

    async function runAutoFillCycle() {
        if (!autoFillActive || autoFillRunning) return;
        if (!autoFillAuthToken) {
            // Try to get token from storage
            const result = await new Promise(resolve => chrome.storage.local.get(['authToken'], resolve));
            autoFillAuthToken = result.authToken;
            if (!autoFillAuthToken) return;
        }

        autoFillRunning = true;

        try {
            // Extract current page text to check if question changed
            const currentText = extractVisiblePageText();
            const textSignature = currentText?.substring(0, 200) || '';

            if (textSignature === lastAutoFilledText) {
                // Same question — skip
                autoFillRunning = false;
                return;
            }

            console.log('%c[Answer Sync] Auto-fill: solving current question...', 'color: #4caf50');
            const fillResult = await handleScanAndAutoFill(autoFillAuthToken);

            if (fillResult.filled && fillResult.filled > 0) {
                lastAutoFilledText = textSignature; // Mark as filled
                console.log(`%c[Answer Sync] Auto-filled ${fillResult.filled} answer(s)! ✅`, 'color: #4caf50; font-weight: bold; font-size: 14px');
            } else if (fillResult.error) {
                console.log(`[Answer Sync] Auto-fill skipped: ${fillResult.error}`);
            }
        } catch (e) {
            console.error('[Answer Sync] Auto-fill error:', e);
        }

        autoFillRunning = false;
    }

    // ============================================================
    // DYNAMIC CONTENT MONITORING
    // Watches for DOM changes, SPA navigation, and dynamically
    // loaded questions (Next button, infinite scroll, AJAX loads)
    // ============================================================

    let lastDetectedQuestions = [];
    let lastQuestionCount = 0;
    let lastUrl = location.href;
    let rescanTimer = null;
    let mutationObserver = null;

    // --- Debounced rescan: prevents flooding on rapid DOM changes ---
    function debouncedRescan() {
        if (rescanTimer) clearTimeout(rescanTimer);
        rescanTimer = setTimeout(() => {
            const questions = scanQuestions();
            const newCount = questions.length;

            // Only update if count changed
            if (newCount !== lastQuestionCount) {
                console.log(`%c[Answer Sync] Dynamic rescan: ${lastQuestionCount} → ${newCount} questions`, 'color: #ff9800; font-weight: bold');
                lastQuestionCount = newCount;
                lastDetectedQuestions = questions;

                // Update badge on extension icon
                try {
                    chrome.runtime.sendMessage({
                        type: 'QUESTION_COUNT_UPDATED',
                        count: newCount
                    }).catch(() => {});
                } catch (e) {}

                // Trigger auto-fill if active
                if (autoFillActive && newCount > 0) {
                    runAutoFillCycle();
                }
            }
        }, 500); // Wait 500ms after last DOM change
    }

    // --- MutationObserver: watches for new/changed content ---
    function startMutationObserver() {
        if (mutationObserver) mutationObserver.disconnect();

        mutationObserver = new MutationObserver((mutations) => {
            // Check if any meaningful content was added (not just attribute changes on our UI)
            let hasRelevantChange = false;
            for (const mutation of mutations) {
                // Skip changes inside our own sidebar
                if (mutation.target.closest && mutation.target.closest('.answersync-sidebar')) continue;
                if (mutation.target.closest && mutation.target.closest('.answersync-button-container')) continue;

                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Check if the added node contains form elements or question-like content
                            if (node.querySelector && (
                                node.querySelector('input, select, textarea, [contenteditable]') ||
                                node.matches && node.matches('input, select, textarea, [contenteditable]') ||
                                (node.innerText && node.innerText.length > 10)
                            )) {
                                hasRelevantChange = true;
                                break;
                            }
                        }
                    }
                }
                if (hasRelevantChange) break;
            }

            if (hasRelevantChange) {
                debouncedRescan();
            }
        });

        mutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    // --- SPA URL change detection ---
    // Intercept pushState/replaceState for SPA navigation
    function setupUrlChangeDetection() {
        // Monitor pushState
        const origPushState = history.pushState;
        history.pushState = function(...args) {
            origPushState.apply(this, args);
            handleUrlChange();
        };

        // Monitor replaceState
        const origReplaceState = history.replaceState;
        history.replaceState = function(...args) {
            origReplaceState.apply(this, args);
            handleUrlChange();
        };

        // Monitor popstate (back/forward)
        window.addEventListener('popstate', handleUrlChange);

        // Monitor hashchange
        window.addEventListener('hashchange', handleUrlChange);
    }

    function handleUrlChange() {
        const newUrl = location.href;
        if (newUrl !== lastUrl) {
            console.log(`%c[Answer Sync] URL changed: ${lastUrl} → ${newUrl}`, 'color: #2196f3; font-weight: bold');
            lastUrl = newUrl;
            lastQuestionCount = 0;
            lastDetectedQuestions = [];
            lastAutoFilledText = ''; // Reset so auto-fill runs on new page

            // Wait for new content to load, then scan
            setTimeout(() => {
                debouncedRescan();
                // Auto-fill if active
                if (autoFillActive) {
                    setTimeout(() => runAutoFillCycle(), 1000);
                }
            }, 800);
        }
    }

    // --- Periodic safety scan: catches anything MutationObserver misses ---
    function startPeriodicScan() {
        setInterval(() => {
            // Only scan if the page has interactive elements
            const hasInputs = document.querySelector('input[type="radio"], input[type="checkbox"], input[type="text"], textarea, select');
            if (hasInputs) {
                debouncedRescan();
            }
        }, 5000); // Check every 5 seconds
    }

    // --- Initialize all watchers ---
    function initDynamicWatching() {
        // Wait for body to exist
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', () => {
                startMutationObserver();
                setupUrlChangeDetection();
                startPeriodicScan();
                // Initial scan
                debouncedRescan();
            });
        } else {
            startMutationObserver();
            setupUrlChangeDetection();
            startPeriodicScan();
            // Initial scan
            debouncedRescan();
        }
    }

    initDynamicWatching();

    // ============================================================
    // SMART SCAN: Wait for dynamic content before scanning
    // ============================================================

    // Wait for DOM to stabilize (no new nodes added for X ms)
    function waitForDOMStable(timeout = 2000, checkInterval = 300) {
        return new Promise(resolve => {
            let lastNodeCount = document.querySelectorAll('*').length;
            let stableChecks = 0;
            const requiredStable = 2; // Must be stable for 2 consecutive checks

            const timer = setInterval(() => {
                const currentCount = document.querySelectorAll('*').length;
                if (currentCount === lastNodeCount) {
                    stableChecks++;
                    if (stableChecks >= requiredStable) {
                        clearInterval(timer);
                        resolve();
                    }
                } else {
                    stableChecks = 0;
                    lastNodeCount = currentCount;
                }
            }, checkInterval);

            // Safety timeout — don't wait forever
            setTimeout(() => {
                clearInterval(timer);
                resolve();
            }, timeout);
        });
    }

    // Smart scan: tries multiple times, waiting for dynamic content
    async function smartScan() {
        // If page isn't fully loaded, wait
        if (document.readyState !== 'complete') {
            await new Promise(resolve => {
                window.addEventListener('load', resolve, { once: true });
                setTimeout(resolve, 3000);
            });
        }

        // First scan
        let questions = scanQuestions();
        if (questions.length > 0) {
            logDetectedQuestions(questions);
            return questions;
        }

        // Wait for DOM to stabilize (SPA content loading)
        await waitForDOMStable(2000, 300);
        questions = scanQuestions();
        if (questions.length > 0) {
            logDetectedQuestions(questions);
            return questions;
        }

        // Final retry after longer wait (very slow SPAs)
        await new Promise(r => setTimeout(r, 1000));
        questions = scanQuestions();
        logDetectedQuestions(questions);
        return questions;
    }

    function logDetectedQuestions(questions) {
        console.log(`%c[Answer Sync] Detected ${questions.length} questions:`, 'color: #00ff88; font-weight: bold');
        questions.forEach((q, i) => {
            console.log(`  Q${i+1} [${q.type}] "${q.questionText}" | Options: [${q.options.join(', ')}]`);
        });
    }

    // ============================================================
    // 3. QUESTION DETECTION ENGINE (Container-first approach)
    //    Find question containers first → extract heading + inputs.
    // ============================================================

    function scanQuestions() {
        const questions = [];
        const processedInputs = new WeakSet();
        let questionId = 0;

        // PHASE 1: Container-first detection
        const allContainers = findQuestionContainers();

        for (const container of allContainers) {
            if (container.closest('.answersync-sidebar')) continue;

            const qText = extractContainerQuestionText(container);
            if (!qText || qText.length < 3) continue;

            const radios = container.querySelectorAll('input[type="radio"]');
            const checkboxes = container.querySelectorAll('input[type="checkbox"]');
            const textInputs = container.querySelectorAll('input[type="text"], input[type="email"], input[type="number"], input[type="date"], input:not([type])');
            const textareas = container.querySelectorAll('textarea');
            const selects = container.querySelectorAll('select');

            if (radios.length > 0) {
                const radiosByName = {};
                radios.forEach(r => {
                    if (r.disabled || r.offsetParent === null) return;
                    const name = r.name || '__unnamed__';
                    if (!radiosByName[name]) radiosByName[name] = [];
                    radiosByName[name].push(r);
                    processedInputs.add(r);
                });
                for (const name in radiosByName) {
                    const group = radiosByName[name];
                    const options = group.map(r => getInputLabel(r)).filter(Boolean);
                    questions.push({ id: `q_${questionId++}`, type: 'radio', questionText: qText, options, element: group[0], allElements: group, context: `Available options: ${options.join(' || ')}` });
                }
            } else if (checkboxes.length > 0) {
                const cbs = Array.from(checkboxes).filter(c => !c.disabled && c.offsetParent !== null);
                if (cbs.length === 0) continue;
                cbs.forEach(c => processedInputs.add(c));
                const options = cbs.map(c => getInputLabel(c)).filter(Boolean);
                questions.push({ id: `q_${questionId++}`, type: 'checkbox', questionText: qText, options, element: cbs[0], allElements: cbs, context: `Options (select all): ${options.join(' || ')}` });
            } else if (selects.length > 0) {
                const sel = selects[0];
                processedInputs.add(sel);
                const options = Array.from(sel.options).filter(o => o.value && o.value !== '' && !o.disabled).map(o => o.text.trim()).filter(Boolean);
                if (options.length === 0) continue;
                questions.push({ id: `q_${questionId++}`, type: 'select', questionText: qText, options, element: sel, allElements: [sel], context: `Options: ${options.join(' || ')}` });
            } else if (textareas.length > 0) {
                const ta = textareas[0];
                processedInputs.add(ta);
                questions.push({ id: `q_${questionId++}`, type: 'textarea', questionText: qText, options: [], element: ta, allElements: [ta], context: getContext(ta) });
            } else if (textInputs.length > 0) {
                textInputs.forEach(inp => {
                    if (inp.type === 'hidden' || inp.type === 'submit' || inp.type === 'button' || inp.type === 'password' || inp.type === 'file') return;
                    processedInputs.add(inp);
                    questions.push({ id: `q_${questionId++}`, type: inp.type || 'text', questionText: qText, options: [], element: inp, allElements: [inp], context: getContext(inp) });
                });
            } else {
                // Custom quiz (divs instead of inputs)
                const clickables = container.querySelectorAll('[class*="option"], [class*="answer"], [class*="choice"], [role="button"]');
                if (clickables.length > 1) {
                    const options = Array.from(clickables).map(c => c.innerText?.trim()).filter(o => o && o.length > 0 && o.length < 200);
                    questions.push({ id: `q_${questionId++}`, type: 'radio', questionText: qText, options: options.slice(0, 10), element: clickables[0], allElements: Array.from(clickables), context: container.innerText?.substring(0, 500) || '' });
                }
            }
        }

        // PHASE 2: Catch orphan inputs not in any container
        document.querySelectorAll('input, textarea, select').forEach(el => {
            if (processedInputs.has(el)) return;
            if (el.disabled || el.offsetParent === null) return;
            if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'password' || el.type === 'file' || el.type === 'image' || el.type === 'reset' || el.type === 'search') return;
            if (el.closest('.answersync-sidebar')) return;

            const qText = extractOrphanQuestionText(el);
            if (!qText || qText.length < 3) return;

            const type = el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : el.type || 'text';
            if (type === 'select') {
                const options = Array.from(el.options).filter(o => o.value && o.value !== '').map(o => o.text.trim()).filter(Boolean);
                if (options.length === 0) return;
                questions.push({ id: `q_${questionId++}`, type, questionText: qText, options, element: el, allElements: [el], context: `Options: ${options.join(' || ')}` });
            } else {
                questions.push({ id: `q_${questionId++}`, type, questionText: qText, options: [], element: el, allElements: [el], context: getContext(el) });
            }
            processedInputs.add(el);
        });

        return questions;
    }

    // --- Find all question containers in document order ---
    function findQuestionContainers() {
        const seen = new WeakSet();
        const containers = [];

        // Strategy: Walk UP from each input to find nearest container with heading + input
        const allInputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"], input[type="text"], input[type="email"], input[type="number"], textarea, select');
        allInputs.forEach(input => {
            if (input.disabled || input.offsetParent === null) return;
            if (input.type === 'hidden' || input.type === 'submit' || input.type === 'password' || input.type === 'file') return;

            const container = findNearestQuestionContainer(input);
            if (container && !seen.has(container)) {
                seen.add(container);
                containers.push(container);
            }
        });

        // Sort by document position
        containers.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        return containers;
    }

    function findNearestQuestionContainer(input) {
        let el = input.parentElement;
        for (let depth = 0; depth < 10 && el; depth++) {
            // Skip labels — they wrap individual options, not questions
            if (el.tagName === 'LABEL') { el = el.parentElement; continue; }

            // Check if this element has a text heading AND contains the input
            const hasHeading = el.querySelector('h1, h2, h3, h4, h5, h6, legend, p, [class*="question"], [class*="prompt"]');
            if (hasHeading) {
                // Count how many distinct "question groups" this container has
                const groups = countQuestionGroups(el);
                if (groups <= 1) return el;
                // If it has too many, keep going up until we find a tighter container
            }

            // Also accept fieldsets, role=radiogroup, or elements with question-like classes
            if (el.tagName === 'FIELDSET' || el.getAttribute('role') === 'radiogroup' || el.getAttribute('role') === 'group') return el;
            const cls = el.className || '';
            if (typeof cls === 'string' && (/question/i.test(cls) || /quiz.?item/i.test(cls) || /form.?group/i.test(cls))) return el;

            el = el.parentElement;
        }
        return null;
    }

    function countQuestionGroups(container) {
        const radioNames = new Set();
        const otherInputs = new Set();
        container.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(inp => radioNames.add(inp.name || Math.random()));
        container.querySelectorAll('input[type="text"], input[type="email"], input[type="number"], textarea, select').forEach(inp => otherInputs.add(inp));
        return radioNames.size + otherInputs.size;
    }

    // --- Extract question text from a container (TOP-DOWN, reliable) ---
    function extractContainerQuestionText(container) {
        // Priority 1: h1-h6, legend
        for (const tag of ['h1','h2','h3','h4','h5','h6','legend']) {
            const heading = container.querySelector(tag);
            if (heading) {
                const text = heading.innerText?.trim();
                if (text && text.length > 3 && text.length < 500) return cleanText(text);
            }
        }
        // Priority 2: p or div with question-like class
        const promptEls = container.querySelectorAll('p, [class*="question"], [class*="prompt"], [class*="qtext"]');
        for (const p of promptEls) {
            if (p.querySelector('input, select, textarea')) continue;
            const text = p.innerText?.trim();
            if (text && text.length > 5 && text.length < 500 && looksLikeQuestion(text)) return cleanText(text);
        }
        // Priority 3: Container's own text minus inputs
        const clone = container.cloneNode(true);
        clone.querySelectorAll('input, select, textarea, label, button').forEach(e => e.remove());
        const directText = clone.innerText?.trim();
        if (directText) {
            const lines = directText.split('\n').map(l => l.trim()).filter(l => l.length > 5);
            const qLine = lines.find(l => looksLikeQuestion(l)) || lines[0];
            if (qLine && qLine.length > 3) return cleanText(qLine);
        }
        // Priority 4: aria-label
        const aria = container.getAttribute('aria-label');
        if (aria && aria.length > 3) return cleanText(aria);

        return null;
    }

    // Fallback for orphan inputs not in containers
    function extractOrphanQuestionText(el) {
        if (el.id) {
            const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (label) return cleanText(label.innerText.trim());
        }
        let sib = el.previousElementSibling;
        for (let i = 0; i < 3 && sib; i++) {
            const t = sib.innerText?.trim();
            if (t && t.length > 3 && t.length < 500) return cleanText(t);
            sib = sib.previousElementSibling;
        }
        if (el.placeholder && el.placeholder.length > 3) return cleanText(el.placeholder);
        if (el.title && el.title.length > 3) return cleanText(el.title);
        return null;
    }

    function looksLikeQuestion(text) {
        if (!text || text.length < 5) return false;
        if (text.includes('?')) return true;
        if (/^\d+[\.)\:]/.test(text)) return true;
        if (/^(what|which|who|where|when|why|how|name|describe|explain|define|list|identify|select|choose|pick|find|true|false)/i.test(text.trim())) return true;
        return false;
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
        if (!text) return null;
        // Get lines, prefer lines with "?"
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return null;
        // Find lines that look like questions
        const qLine = lines.find(l => l.includes('?'));
        const numberedLine = lines.find(l => /^\d+[\.\)\:]/.test(l));
        const result = qLine || numberedLine || lines[0];
        // Keep full question, just cap length
        return result.length > 500 ? result.substring(0, 500) + '...' : result;
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
        // Word-level matching: check if most words overlap
        const wordsA = cleanA.split(/\s+/).filter(w => w.length > 1);
        const wordsB = cleanB.split(/\s+/).filter(w => w.length > 1);
        if (wordsA.length > 0 && wordsB.length > 0) {
            const overlap = wordsA.filter(w => wordsB.includes(w)).length;
            const matchRatio = overlap / Math.min(wordsA.length, wordsB.length);
            if (matchRatio >= 0.7) return true;
        }
        return false;
    }

    // Find the best matching option using scoring
    function findBestMatch(options, answerText) {
        if (!answerText || options.length === 0) return -1;
        const answer = answerText.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
        let bestScore = 0;
        let bestIdx = -1;

        for (let i = 0; i < options.length; i++) {
            const opt = (options[i] || '').toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
            if (!opt) continue;

            let score = 0;
            // Exact match
            if (opt === answer) score = 100;
            // Contains match
            else if (answer.includes(opt)) score = 80;
            else if (opt.includes(answer)) score = 75;
            // Word overlap
            else {
                const ansWords = answer.split(/\s+/).filter(w => w.length > 1);
                const optWords = opt.split(/\s+/).filter(w => w.length > 1);
                if (ansWords.length > 0 && optWords.length > 0) {
                    const overlap = optWords.filter(w => ansWords.includes(w)).length;
                    score = (overlap / optWords.length) * 60;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }
        return bestScore >= 40 ? bestIdx : -1;
    }

    // ============================================================
    // 6. AUTO-FILL ENGINE (Research-backed reliability)
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
                    return fillTextarea(questionObj.element, answerText);

                case 'contenteditable':
                    return fillContentEditable(questionObj.element, answerText);

                case 'radio':
                    return fillRadio(questionObj.allElements, answerText, questionObj.options);

                case 'checkbox':
                    return fillCheckboxes(questionObj.allElements, answerText, questionObj.options);

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

    // --- TEXT INPUT: Use native setter + execCommand fallback ---
    function fillTextInput(el, value) {
        el.focus();

        // Method 1: execCommand (most reliable for React/Vue/Angular)
        el.select && el.select();
        const execResult = document.execCommand('insertText', false, value);

        if (!execResult || el.value !== value) {
            // Method 2: Native setter bypass (for React controlled components)
            const proto = el.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

            if (nativeSetter) {
                nativeSetter.call(el, value);
            } else {
                el.value = value;
            }

            // Dispatch full event sequence
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        el.dispatchEvent(new Event('blur', { bubbles: true }));
        addFillAnimation(el);
        return true;
    }

    // --- TEXTAREA: Same approach as text but uses textarea prototype ---
    function fillTextarea(el, value) {
        return fillTextInput(el, value);
    }

    // --- CONTENTEDITABLE: Use execCommand for framework compat ---
    function fillContentEditable(el, value) {
        el.focus();

        // Clear existing content
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);

        // Insert text
        const execResult = document.execCommand('insertText', false, value);
        if (!execResult) {
            el.innerText = value;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        addFillAnimation(el);
        return true;
    }

    // --- RADIO: Native checked setter + full click simulation ---
    function fillRadio(radioElements, answerText, options) {
        // Strategy 1: Use fuzzyMatch on labels
        for (const radio of radioElements) {
            const label = getInputLabel(radio);
            if (fuzzyMatch(label, answerText) || fuzzyMatch(radio.value, answerText)) {
                return clickRadio(radio);
            }
        }

        // Strategy 2: Use findBestMatch scoring on all option labels
        if (options && options.length > 0) {
            const bestIdx = findBestMatch(options, answerText);
            if (bestIdx >= 0 && bestIdx < radioElements.length) {
                return clickRadio(radioElements[bestIdx]);
            }
        }

        // Strategy 3: Try matching on values
        const answerClean = answerText.toLowerCase().trim();
        for (const radio of radioElements) {
            if (radio.value && radio.value.toLowerCase().trim() === answerClean) {
                return clickRadio(radio);
            }
        }

        return false;
    }

    function clickRadio(radio) {
        // Use native checked setter to bypass framework interception
        const nativeCheckedSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'checked'
        )?.set;

        if (nativeCheckedSetter) {
            nativeCheckedSetter.call(radio, true);
        } else {
            radio.checked = true;
        }

        // Simulate full user interaction event sequence
        radio.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        radio.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        radio.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true }));

        // Also click the label if available (some sites listen on label)
        const label = radio.closest('label') || (radio.id && document.querySelector(`label[for="${CSS.escape(radio.id)}"]`));
        if (label) {
            label.click();
        }

        addFillAnimation(label || radio);
        return true;
    }

    // --- CHECKBOX: Native setter + scoring-based match ---
    function fillCheckboxes(checkboxElements, answerText, options) {
        // Parse answer: could be JSON array, comma-separated, or single value
        let selectedOptions = [];
        try {
            const parsed = JSON.parse(answerText);
            selectedOptions = Array.isArray(parsed) ? parsed : [String(parsed)];
        } catch {
            selectedOptions = answerText.split(',').map(s => s.trim()).filter(Boolean);
            if (selectedOptions.length === 0) selectedOptions = [answerText.trim()];
        }

        let filled = false;
        const nativeCheckedSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'checked'
        )?.set;

        for (const cb of checkboxElements) {
            const label = getInputLabel(cb);
            const shouldCheck = selectedOptions.some(opt =>
                fuzzyMatch(label, opt) || fuzzyMatch(cb.value, opt)
            );

            if (nativeCheckedSetter) {
                nativeCheckedSetter.call(cb, shouldCheck);
            } else {
                cb.checked = shouldCheck;
            }

            if (shouldCheck) {
                cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                cb.dispatchEvent(new Event('input', { bubbles: true }));
                cb.dispatchEvent(new Event('change', { bubbles: true }));
                addFillAnimation(cb.closest('label') || cb);
                filled = true;
            }
        }
        return filled;
    }

    // --- SELECT: Scoring-based match + native value setter ---
    function fillSelect(selectEl, answerText) {
        // Strategy 1: Direct fuzzy match
        for (const option of selectEl.options) {
            if (fuzzyMatch(option.text, answerText) || fuzzyMatch(option.value, answerText)) {
                return selectOption(selectEl, option);
            }
        }

        // Strategy 2: Best match scoring
        const optTexts = Array.from(selectEl.options).map(o => o.text.trim());
        const bestIdx = findBestMatch(optTexts, answerText);
        if (bestIdx >= 0) {
            return selectOption(selectEl, selectEl.options[bestIdx]);
        }

        return false;
    }

    function selectOption(selectEl, option) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype, 'value'
        )?.set;

        if (nativeSetter) {
            nativeSetter.call(selectEl, option.value);
        } else {
            selectEl.value = option.value;
        }

        option.selected = true;
        selectEl.dispatchEvent(new Event('input', { bubbles: true }));
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        addFillAnimation(selectEl);
        return true;
    }

    function addFillAnimation(el) {
        if (!el) return;
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
    // UNIVERSAL TEXT EXTRACTION (DOM-agnostic)
    // ============================================================

    function extractVisiblePageText() {
        // Remove our own UI first
        const ourUI = document.querySelectorAll('.answersync-sidebar, .answersync-button-container');
        ourUI.forEach(el => el.style.display = 'none');

        // Grab ALL visible text — let the AI filter out noise
        const text = document.body.innerText || '';

        // Restore our UI
        ourUI.forEach(el => el.style.display = '');

        console.log(`[Answer Sync] Extracted ${text.length} chars of text`);
        return cleanPageText(text);
    }

    function cleanPageText(text) {
        // Remove excessive whitespace but keep structure
        return text
            .replace(/\n{3,}/g, '\n\n')        // Max 2 newlines
            .replace(/[ \t]{2,}/g, ' ')          // Collapse spaces
            .replace(/^\s+$/gm, '')              // Remove blank lines
            .substring(0, 8000);                  // Cap at 8000 chars
    }

    // Count questions from visible text using heuristics (no API call)
    function countQuestionsFromText() {
        const text = extractVisiblePageText();
        if (!text || text.length < 30) return 0;

        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);
        let count = 0;
        const seen = new Set();

        for (const line of lines) {
            // Skip duplicates
            const key = line.substring(0, 60);
            if (seen.has(key)) continue;

            // Match question-like patterns
            if (
                /\?/.test(line) ||                           // Has question mark
                /^\d+[\.\)\:]/.test(line) ||                 // "1. ..." or "1) ..."
                /^(Question|Q)\s*\d/i.test(line) ||          // "Question 1" or "Q1"
                /^(what|which|who|where|when|why|how|select|choose|identify|name|describe|explain|true or false)/i.test(line)
            ) {
                // Must be long enough to be a real question
                if (line.length > 15) {
                    count++;
                    seen.add(key);
                }
            }
        }

        // Also check for "Question X/Y" pattern (e.g., "Question 01/08")
        const qMatch = text.match(/Question\s+(\d+)\s*\/\s*(\d+)/i);
        if (qMatch && count === 0) {
            // Single question at a time (paginated quiz)
            count = 1;
        }

        console.log(`%c[Answer Sync] Text analysis found ${count} question(s)`, 'color: #ff9800; font-weight: bold');
        return count;
    }

    // ============================================================
    // 8. SCAN & REVIEW Handler (Universal AI-first)
    // ============================================================

    async function handleScanAndReview(authToken) {
        // Try 1: DOM-based detection (works for standard HTML forms)
        const domQuestions = await smartScan();

        if (domQuestions.length > 0) {
            // DOM detection succeeded — use legacy flow
            const apiQuestions = domQuestions.map(q => ({
                id: q.id, type: q.type, questionText: q.questionText,
                options: q.options, context: q.context
            }));

            const result = await new Promise(resolve => {
                chrome.runtime.sendMessage({
                    type: 'SOLVE_BATCH', questions: apiQuestions, authToken
                }, resolve);
            });

            if (result.error) return { error: result.error };
            createSidebar(domQuestions, result.answers || []);
            return { success: true, count: domQuestions.length };
        }

        // Try 2: Universal text extraction (works on ANY site)
        console.log('%c[Answer Sync] DOM detection found 0 questions → using AI text analysis', 'color: #ff9800; font-weight: bold');
        const pageText = extractVisiblePageText();
        console.log('[Answer Sync] Extracted text length:', pageText?.length, 'Preview:', pageText?.substring(0, 200));
        if (!pageText || pageText.trim().length < 30) {
            return { error: 'No readable content found on this page.' };
        }

        const result = await new Promise(resolve => {
            chrome.runtime.sendMessage({
                type: 'SOLVE_TEXT',
                pageText,
                pageUrl: location.href,
                authToken
            }, resolve);
        });

        console.log('[Answer Sync] API result:', JSON.stringify(result).substring(0, 500));

        if (result.error) return { error: result.error };

        let aiQuestions = result.questions || [];

        // Fallback: if parsing failed but AI returned raw text, create a single Q&A
        if (aiQuestions.length === 0 && result.rawText) {
            console.log('[Answer Sync] Using rawText fallback:', result.rawText.substring(0, 200));
            aiQuestions = [{
                id: 'q_0',
                question: 'AI Analysis',
                options: [],
                answer: result.rawText,
                confidence: 0.7
            }];
        }

        if (aiQuestions.length === 0) {
            return { error: 'AI could not identify any questions on this page.' };
        }

        // Convert AI questions to our format for sidebar display
        const displayQuestions = aiQuestions.map((q, i) => ({
            id: q.id || `q_${i}`,
            type: q.options && q.options.length > 0 ? 'radio' : 'text',
            questionText: q.question,
            options: q.options || [],
            element: null,
            allElements: [],
            context: ''
        }));

        const displayAnswers = aiQuestions.map((q, i) => ({
            id: q.id || `q_${i}`,
            answer: q.answer,
            confidence: q.confidence || 0.5
        }));

        createSidebar(displayQuestions, displayAnswers);
        return { success: true, count: aiQuestions.length };
    }

    // ============================================================
    // 9. SCAN & AUTO-FILL Handler (Universal)
    // ============================================================

    async function handleScanAndAutoFill(authToken) {
        // Try 1: DOM-based
        const domQuestions = await smartScan();

        if (domQuestions.length > 0) {
            const apiQuestions = domQuestions.map(q => ({
                id: q.id, type: q.type, questionText: q.questionText,
                options: q.options, context: q.context
            }));

            const result = await new Promise(resolve => {
                chrome.runtime.sendMessage({
                    type: 'SOLVE_BATCH', questions: apiQuestions, authToken
                }, resolve);
            });

            if (result.error) return { error: result.error };

            let filledCount = 0;
            const answers = result.answers || [];
            for (const q of domQuestions) {
                const answer = answers.find(a => a.id === q.id);
                if (answer && answer.answer) {
                    const filled = fillAnswer(q, answer.answer);
                    if (filled) filledCount++;
                }
            }
            return { filled: filledCount, total: domQuestions.length };
        }

        // Try 2: Universal text → AI → universal fill
        console.log('%c[Answer Sync] Auto-fill: using AI text analysis', 'color: #ff9800; font-weight: bold');
        const pageText = extractVisiblePageText();
        if (!pageText || pageText.trim().length < 30) {
            return { error: 'No readable content found on this page.' };
        }

        const result = await new Promise(resolve => {
            chrome.runtime.sendMessage({
                type: 'SOLVE_TEXT',
                pageText,
                pageUrl: location.href,
                authToken
            }, resolve);
        });

        if (result.error) return { error: result.error };

        const aiQuestions = result.questions || [];
        if (aiQuestions.length === 0) {
            return { error: 'AI could not identify any questions on this page.' };
        }

        // Universal fill: find answer elements by text match
        let filledCount = 0;
        for (const q of aiQuestions) {
            if (q.answer) {
                const filled = universalFill(q.answer, q.options || []);
                if (filled) filledCount++;
            }
        }

        return { filled: filledCount, total: aiQuestions.length };
    }

    // ============================================================
    // 10. UNIVERSAL FILL ENGINE (click anything by text match)
    // ============================================================

    function universalFill(answerText, options) {
        if (!answerText) return false;
        const answer = answerText.trim();

        // Strategy 1: Find standard inputs first
        const standardFilled = tryStandardInputFill(answer);
        if (standardFilled) return true;

        // Strategy 2: Find clickable element by exact text match
        const exactMatch = findElementByText(answer, true);
        if (exactMatch) {
            clickElement(exactMatch);
            addFillAnimation(exactMatch);
            return true;
        }

        // Strategy 3: Find clickable element by fuzzy text match
        const fuzzyEl = findElementByText(answer, false);
        if (fuzzyEl) {
            clickElement(fuzzyEl);
            addFillAnimation(fuzzyEl);
            return true;
        }

        // Strategy 4: Find by ARIA role
        const ariaEl = findByAriaRole(answer);
        if (ariaEl) {
            clickElement(ariaEl);
            addFillAnimation(ariaEl);
            return true;
        }

        return false;
    }

    function findElementByText(text, exact) {
        const search = text.toLowerCase().trim();
        // Walk all visible elements, prefer smaller (more specific) ones
        const candidates = [];

        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_ELEMENT,
            {
                acceptNode: (node) => {
                    if (node.closest('.answersync-sidebar')) return NodeFilter.FILTER_REJECT;
                    if (node.offsetParent === null && node.tagName !== 'BODY') return NodeFilter.FILTER_SKIP;
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        let node;
        while (node = walker.nextNode()) {
            const nodeText = node.innerText?.trim();
            if (!nodeText) continue;
            const nodeTextLower = nodeText.toLowerCase();

            // Skip if this element has too many children (it's a container, not an option)
            if (node.children.length > 5) continue;

            if (exact) {
                if (nodeTextLower === search) {
                    candidates.push({ el: node, score: 100, len: nodeText.length });
                }
            } else {
                // Fuzzy: check if the node text contains the answer or vice versa
                const cleanNode = nodeTextLower.replace(/[^a-z0-9\s]/g, '').trim();
                const cleanSearch = search.replace(/[^a-z0-9\s]/g, '').trim();
                if (cleanNode === cleanSearch) {
                    candidates.push({ el: node, score: 90, len: nodeText.length });
                } else if (cleanNode.includes(cleanSearch) && cleanSearch.length > 5) {
                    candidates.push({ el: node, score: 70, len: nodeText.length });
                } else if (cleanSearch.includes(cleanNode) && cleanNode.length > 5) {
                    candidates.push({ el: node, score: 60, len: nodeText.length });
                }
            }
        }

        if (candidates.length === 0) return null;

        // Prefer: highest score, then shortest text (most specific element)
        candidates.sort((a, b) => b.score - a.score || a.len - b.len);
        return candidates[0].el;
    }

    function findByAriaRole(answerText) {
        const search = answerText.toLowerCase().trim();
        const ariaElements = document.querySelectorAll('[role="radio"], [role="option"], [role="checkbox"], [role="menuitem"]');
        for (const el of ariaElements) {
            const text = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase().trim();
            if (text === search || text.includes(search) || search.includes(text)) {
                return el;
            }
        }
        return null;
    }

    function tryStandardInputFill(answer) {
        // Check if there are standard radio/checkbox inputs with matching labels
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const radio of radios) {
            const label = getInputLabel(radio);
            if (fuzzyMatch(label, answer) || fuzzyMatch(radio.value, answer)) {
                clickRadio(radio);
                return true;
            }
        }
        return false;
    }

    function clickElement(el) {
        // Simulate full user click sequence
        el.focus && el.focus();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

        // If it has an aria-checked attribute, toggle it
        if (el.hasAttribute('aria-checked')) {
            el.setAttribute('aria-checked', 'true');
        }

        // Also try .click() as a fallback
        try { el.click(); } catch (e) {}

        console.log(`%c[Answer Sync] Clicked: "${el.innerText?.substring(0, 50)}"`, 'color: #4caf50');
    }

})();

