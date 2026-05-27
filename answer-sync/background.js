/**
 * Answer Sync — Background Service Worker
 * Handles: API calls to backend, message routing, auth token relay, screenshot capture.
 * MV3 best practice: No global variables — all state from chrome.storage.
 */

const BACKEND_URL = 'https://answer-sync-web.vercel.app';

// ---- Message Routing ----
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Legacy: structured question solving
    if (request.type === 'SOLVE_BATCH') {
        handleSolveBatch(request.questions, request.authToken)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    // NEW: Universal text-based solving
    if (request.type === 'SOLVE_TEXT') {
        handleSolveText(request.pageText, request.pageUrl, request.authToken)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    // Screenshot capture (only background can do this)
    if (request.type === 'CAPTURE_SCREENSHOT') {
        chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 }, (dataUrl) => {
            if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ screenshot: dataUrl });
            }
        });
        return true;
    }

    if (request.type === 'VALIDATE_TOKEN') {
        validateToken(request.authToken)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    // Live question count badge update from content script
    if (request.type === 'QUESTION_COUNT_UPDATED') {
        const count = request.count || 0;
        const tabId = sender.tab?.id;
        if (tabId) {
            chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
            chrome.action.setBadgeBackgroundColor({ color: '#6c5ce7', tabId });
        }
        return false;
    }
});

// ---- Universal Text-based Solving ----
async function handleSolveText(pageText, pageUrl, authToken) {
    if (!authToken) {
        return { error: 'Not authenticated. Please sign in.' };
    }
    if (!pageText || pageText.trim().length < 20) {
        return { error: 'No readable text found on this page.' };
    }

    try {
        const response = await fetch(`${BACKEND_URL}/api/solve-text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ pageText, pageUrl })
        });

        if (response.status === 401) {
            chrome.storage.local.remove(['authToken', 'userEmail', 'userTier', 'dailyCreditsUsed']);
            return { error: 'Session expired. Please sign in again.' };
        }
        if (response.status === 429) {
            return { error: 'Daily credit limit reached.' };
        }
        if (!response.ok) {
            const errText = await response.text();
            return { error: `Server error (${response.status}): ${errText}` };
        }

        const data = await response.json();

        // Update credits
        if (data.creditsRemaining !== undefined) {
            chrome.storage.local.get(['dailyCreditLimit'], (result) => {
                const limit = result.dailyCreditLimit || 20;
                chrome.storage.local.set({ dailyCreditsUsed: limit - data.creditsRemaining });
            });
        }

        return { questions: data.questions || [], rawText: data.rawText, creditsRemaining: data.creditsRemaining };
    } catch (error) {
        return { error: 'Network error. Check your connection.' };
    }
}

// ---- Legacy: Structured Solve Batch ----
async function handleSolveBatch(questions, authToken) {
    if (!authToken) {
        return { error: 'Not authenticated. Please sign in from the extension popup.' };
    }
    if (!questions || questions.length === 0) {
        return { error: 'No questions detected on this page.' };
    }

    try {
        const response = await fetch(`${BACKEND_URL}/api/solve`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ questions })
        });

        if (response.status === 401) {
            chrome.storage.local.remove(['authToken', 'userEmail', 'userTier', 'dailyCreditsUsed']);
            chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED' }).catch(() => {});
            return { error: 'Session expired. Please sign in again.' };
        }
        if (response.status === 429) {
            return { error: 'Daily credit limit reached.' };
        }
        if (!response.ok) {
            const errText = await response.text();
            return { error: `Server error (${response.status}): ${errText}` };
        }

        const data = await response.json();

        if (data.creditsRemaining !== undefined) {
            chrome.storage.local.get(['dailyCreditLimit'], (result) => {
                const limit = result.dailyCreditLimit || 20;
                chrome.storage.local.set({ dailyCreditsUsed: limit - data.creditsRemaining });
            });
        }

        return { answers: data.answers || [], creditsRemaining: data.creditsRemaining };
    } catch (error) {
        if (error.name === 'AbortError') return { error: 'Request cancelled.' };
        return { error: 'Network error. Please check your connection.' };
    }
}

// ---- Validate Auth Token ----
async function validateToken(authToken) {
    try {
        const response = await fetch(`${BACKEND_URL}/api/user`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (response.ok) {
            const data = await response.json();
            return { valid: true, user: data };
        }
        return { valid: false };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}
