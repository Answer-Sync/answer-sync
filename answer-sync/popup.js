/**
 * Answer Sync — Popup Script
 * Handles: auth state, mode selection, question count, progress tracking.
 */

const BACKEND_URL = 'https://answer-sync-web.vercel.app';

document.addEventListener('DOMContentLoaded', () => {
    // Views
    const loggedOutView = document.getElementById('loggedOutView');
    const loggedInView = document.getElementById('loggedInView');
    const processingView = document.getElementById('processingView');

    // Auth elements
    const signInBtn = document.getElementById('signInBtn');
    const signOutBtn = document.getElementById('signOutBtn');
    const userEmail = document.getElementById('userEmail');
    const userInitial = document.getElementById('userInitial');
    const tierBadge = document.getElementById('tierBadge');
    const creditCount = document.getElementById('creditCount');

    // Action elements
    const reviewBtn = document.getElementById('reviewBtn');
    const autoFillBtn = document.getElementById('autoFillBtn');
    const dashboardBtn = document.getElementById('dashboardBtn');
    const questionCount = document.getElementById('questionCount');

    // Processing elements
    const processingText = document.getElementById('processingText');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const cancelBtn = document.getElementById('cancelBtn');

    // Status
    const statusMessage = document.getElementById('statusMessage');

    let currentAbortController = null;

    // ---- Initialize ----
    checkAuthState();

    // ---- Auth State ----
    function checkAuthState() {
        chrome.storage.local.get(
            ['authToken', 'userEmail', 'userTier', 'dailyCreditsUsed', 'dailyCreditLimit'],
            (result) => {
                if (result.authToken && result.userEmail) {
                    showLoggedInView(result);
                    fetchQuestionCount();
                    refreshUserInfo(result.authToken);
                } else {
                    showLoggedOutView();
                }
            }
        );
    }

    function showLoggedOutView() {
        loggedOutView.classList.remove('hidden');
        loggedInView.classList.add('hidden');
        processingView.classList.add('hidden');
    }

    function showLoggedInView(data) {
        loggedOutView.classList.add('hidden');
        loggedInView.classList.remove('hidden');
        processingView.classList.add('hidden');

        userEmail.textContent = data.userEmail || 'user@gmail.com';
        userInitial.textContent = (data.userEmail || '?')[0].toUpperCase();

        const tier = data.userTier || 'free';
        tierBadge.textContent = tier === 'pro' ? 'PRO' : 'FREE';
        tierBadge.className = `tier-badge ${tier}`;

        if (tier === 'free') {
            const used = data.dailyCreditsUsed || 0;
            const limit = data.dailyCreditLimit || 20;
            creditCount.textContent = `${limit - used}/${limit} credits`;
            creditCount.classList.remove('hidden');
        } else {
            creditCount.textContent = 'Unlimited';
            creditCount.classList.remove('hidden');
        }
    }

    function showProcessingView(text) {
        loggedOutView.classList.add('hidden');
        loggedInView.classList.add('hidden');
        processingView.classList.remove('hidden');

        processingText.textContent = text || 'Generating answers...';
        progressBar.style.width = '0%';
        progressText.textContent = '';
    }

    function updateProgress(current, total) {
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        progressBar.style.width = `${pct}%`;
        progressText.textContent = `${current}/${total}`;
    }

    async function refreshUserInfo(token) {
        try {
            const res = await fetch(`${BACKEND_URL}/api/user`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                chrome.storage.local.set({
                    userTier: data.tier,
                    dailyCreditsUsed: data.dailyCreditsUsed,
                    dailyCreditLimit: data.dailyCreditLimit,
                    hasApiKey: data.hasApiKey
                });
                showLoggedInView({
                    userEmail: data.email,
                    userTier: data.tier,
                    dailyCreditsUsed: data.dailyCreditsUsed,
                    dailyCreditLimit: data.dailyCreditLimit
                });
            }
        } catch (e) {
            console.log('Answer Sync: Could not reach backend for user refresh.');
        }
    }

    // ---- Fetch Question Count from Content Script ----
    function fetchQuestionCount() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs[0]) {
                questionCount.textContent = 'No active tab';
                return;
            }
            chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_QUESTION_COUNT' }, (response) => {
                if (chrome.runtime.lastError) {
                    questionCount.textContent = 'Open a page with questions';
                    return;
                }
                if (response && typeof response.count === 'number') {
                    if (response.count > 0) {
                        questionCount.textContent = `${response.count} question${response.count !== 1 ? 's' : ''} found`;
                    } else if (response.aiModeAvailable) {
                        questionCount.textContent = '🚀 AI mode ready — click to detect';
                        questionCount.style.color = '#6c5ce7';
                    } else {
                        questionCount.textContent = 'No questions detected on this page';
                    }
                } else {
                    questionCount.textContent = 'Scanning...';
                }
            });
        });
    }

    // ---- Show Status Message ----
    function showStatus(message, type = 'info') {
        statusMessage.textContent = message;
        statusMessage.className = `status-message ${type}`;
        statusMessage.classList.remove('hidden');
        setTimeout(() => {
            statusMessage.classList.add('hidden');
        }, 4000);
    }

    // ---- Event Listeners ----

    // Sign In
    signInBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: `${BACKEND_URL}/login?source=extension` });
    });

    // Sign Out
    signOutBtn.addEventListener('click', () => {
        chrome.storage.local.remove(
            ['authToken', 'userEmail', 'userTier', 'dailyCreditsUsed', 'dailyCreditLimit', 'hasApiKey'],
            () => {
                showLoggedOutView();
                showStatus('Signed out successfully', 'info');
            }
        );
    });

    // Dashboard
    dashboardBtn.addEventListener('click', () => {
        chrome.storage.local.get(['authToken'], (result) => {
            const tokenQuery = result.authToken ? `?token=${result.authToken}` : '';
            chrome.tabs.create({ url: `${BACKEND_URL}/dashboard${tokenQuery}` });
        });
    });

    // Review Mode
    reviewBtn.addEventListener('click', () => {
        chrome.storage.local.get(['authToken'], (result) => {
            if (!result.authToken) {
                showStatus('Please sign in first', 'error');
                return;
            }

            showProcessingView('Scanning & generating answers...');

            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (!tabs || !tabs[0]) {
                    showStatus('No active tab found', 'error');
                    checkAuthState();
                    return;
                }

                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'SCAN_AND_REVIEW',
                    authToken: result.authToken
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        showStatus('Could not connect to page. Try refreshing.', 'error');
                        checkAuthState();
                        return;
                    }
                    if (response && response.error) {
                        showStatus(response.error, 'error');
                        checkAuthState();
                    } else {
                        window.close();
                    }
                });
            });
        });
    });

    // Auto-Fill Mode
    autoFillBtn.addEventListener('click', () => {
        chrome.storage.local.get(['authToken'], (result) => {
            if (!result.authToken) {
                showStatus('Please sign in first', 'error');
                return;
            }

            showProcessingView('Auto-filling all answers...');

            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (!tabs || !tabs[0]) {
                    showStatus('No active tab found', 'error');
                    checkAuthState();
                    return;
                }

                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'SCAN_AND_AUTOFILL',
                    authToken: result.authToken
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        showStatus('Could not connect to page. Try refreshing.', 'error');
                        checkAuthState();
                        return;
                    }
                    if (response && response.error) {
                        showStatus(response.error, 'error');
                        checkAuthState();
                    } else if (response && response.filled !== undefined) {
                        showStatus(`✅ Filled ${response.filled} answer(s)!`, 'success');
                        setTimeout(() => checkAuthState(), 2000);
                    } else {
                        window.close();
                    }
                });
            });
        });
    });

    // Cancel processing
    cancelBtn.addEventListener('click', () => {
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
        checkAuthState();
    });

    // Listen for progress updates from background
    chrome.runtime.onMessage.addListener((request) => {
        if (request.type === 'PROGRESS_UPDATE') {
            updateProgress(request.current, request.total);
        }
        if (request.type === 'AUTH_STATE_CHANGED') {
            checkAuthState();
        }
    });
});
