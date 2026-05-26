/**
 * Answer Sync — Background Service Worker
 * Handles: API calls to backend, message routing, auth token relay.
 * MV3 best practice: No global variables — all state from chrome.storage.
 */

const BACKEND_URL = 'https://answer-sync-web.vercel.app';

// ---- Message Routing ----
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'SOLVE_BATCH') {
        handleSolveBatch(request.questions, request.authToken)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        return true; // async response
    }

    if (request.type === 'VALIDATE_TOKEN') {
        validateToken(request.authToken)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
});

// ---- Solve Batch Questions ----
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
            // Token expired or invalid — clear auth
            chrome.storage.local.remove(['authToken', 'userEmail', 'userTier', 'dailyCreditsUsed']);
            chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED' }).catch(() => {});
            return { error: 'Session expired. Please sign in again.' };
        }

        if (response.status === 429) {
            return { error: 'Daily credit limit reached. Add your own API key on the dashboard for unlimited access.' };
        }

        if (!response.ok) {
            const errText = await response.text();
            return { error: `Server error (${response.status}): ${errText}` };
        }

        const data = await response.json();

        // Update local credit info
        if (data.creditsRemaining !== undefined) {
            chrome.storage.local.get(['dailyCreditLimit'], (result) => {
                const limit = result.dailyCreditLimit || 20;
                chrome.storage.local.set({
                    dailyCreditsUsed: limit - data.creditsRemaining
                });
            });
        }

        return {
            answers: data.answers || [],
            creditsRemaining: data.creditsRemaining
        };

    } catch (error) {
        if (error.name === 'AbortError') {
            return { error: 'Request cancelled.' };
        }
        console.error('Answer Sync: Solve batch error:', error);
        return { error: 'Network error. Please check your connection and try again.' };
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
