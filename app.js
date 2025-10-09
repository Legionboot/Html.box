const DB_NAME = 'mono-super-platform';
const DB_VERSION = 1;
const DEV_CODE = 'dev:1234';
const STORES = ['meta', 'users', 'profiles', 'chats', 'messages', 'posts', 'comments', 'likes', 'logs'];

const q = (sel, parent = document) => parent.querySelector(sel);
const qa = (sel, parent = document) => Array.from(parent.querySelectorAll(sel));

const escapeHTML = (value = '') =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeInput = (value = '') => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${value}</body>`, 'text/html');
  return (doc.body.textContent || '').trim();
};

class DataLayer {
  constructor() {
    this.db = null;
    this.eventTarget = new EventTarget();
  }

  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        STORES.forEach((store) => {
          if (!db.objectStoreNames.contains(store)) {
            switch (store) {
              case 'meta':
                db.createObjectStore('meta', { keyPath: 'key' });
                break;
              case 'users':
                db.createObjectStore('users', { keyPath: 'id' });
                break;
              case 'profiles':
                db.createObjectStore('profiles', { keyPath: 'id' });
                break;
              case 'chats': {
                const s = db.createObjectStore('chats', { keyPath: 'id' });
                s.createIndex('by_participant', 'participants', { multiEntry: true });
                break;
              }
              case 'messages': {
                const s = db.createObjectStore('messages', { keyPath: 'id' });
                s.createIndex('by_chat', 'chatId');
                s.createIndex('by_time', 'time');
                break;
              }
              case 'posts': {
                const s = db.createObjectStore('posts', { keyPath: 'id' });
                s.createIndex('by_author', 'authorProfileId');
                s.createIndex('by_type', 'type');
                break;
              }
              case 'comments': {
                const s = db.createObjectStore('comments', { keyPath: 'id' });
                s.createIndex('by_post', 'postId');
                break;
              }
              case 'likes': {
                const s = db.createObjectStore('likes', { keyPath: 'id' });
                s.createIndex('by_post', 'postId');
                s.createIndex('by_profile', 'profileId');
                break;
              }
              case 'logs': {
                const s = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
                s.createIndex('by_time', 'time');
                break;
              }
              default:
                db.createObjectStore(store, { keyPath: 'id' });
            }
          }
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    this.db.onversionchange = () => {
      this.db.close();
      alert('Версия базы данных обновлена. Перезагрузите страницу.');
    };

    const seeded = await this.get('meta', 'seeded');
    if (!seeded) {
      await this.seed();
    }
    return this.db;
  }

  async seed() {
    const response = await fetch('seed-db.json');
    const data = await response.json();
    const tx = this.db.transaction(STORES, 'readwrite');
    await Promise.all(
      STORES.map((store) => {
        if (store === 'meta') return Promise.resolve();
        const objectStore = tx.objectStore(store);
        const items = data[store] || [];
        return Promise.all(
          items.map(
            (item) =>
              new Promise((resolve, reject) => {
                const req = objectStore.put(item);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
              })
          )
        );
      })
    );
    tx.objectStore('meta').put({ key: 'seeded', value: true, time: Date.now() });
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await this.recordLog('seed', { info: 'Seed database loaded' });
  }

  async transaction(storeNames, mode = 'readonly') {
    const db = await this.open();
    return db.transaction(storeNames, mode);
  }

  async get(store, key) {
    const tx = await this.transaction([store], 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(store, indexName, query) {
    const tx = await this.transaction([store], 'readonly');
    const objectStore = tx.objectStore(store);
    return new Promise((resolve, reject) => {
      const req = indexName
        ? objectStore.index(indexName).getAll(query)
        : objectStore.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async put(store, value) {
    const tx = await this.transaction([store], 'readwrite');
    await new Promise((resolve, reject) => {
      const req = tx.objectStore(store).put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await this.recordLog('put', { store, value });
    this.dispatch(`${store}:change`);
    return value;
  }

  async bulkPut(store, values) {
    const tx = await this.transaction([store], 'readwrite');
    const storeRef = tx.objectStore(store);
    await Promise.all(
      values.map(
        (value) =>
          new Promise((resolve, reject) => {
            const req = storeRef.put(value);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          })
      )
    );
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await this.recordLog('bulkPut', { store, count: values.length });
    this.dispatch(`${store}:change`);
    return values;
  }

  async delete(store, key) {
    const tx = await this.transaction([store], 'readwrite');
    await new Promise((resolve, reject) => {
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await this.recordLog('delete', { store, key });
    this.dispatch(`${store}:change`);
  }

  async clearAll() {
    const tx = await this.transaction(STORES, 'readwrite');
    await Promise.all(
      STORES.map(
        (store) =>
          new Promise((resolve, reject) => {
            const req = tx.objectStore(store).clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          })
      )
    );
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    await this.recordLog('reset', { info: 'database cleared' });
    this.dispatch('db:reset');
  }

  async recordLog(action, payload) {
    const entry = {
      action,
      payload,
      time: Date.now(),
    };
    const tx = await this.transaction(['logs'], 'readwrite');
    await new Promise((resolve, reject) => {
      const req = tx.objectStore('logs').add(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    this.dispatch('logs:change');
  }

  dispatch(name) {
    this.eventTarget.dispatchEvent(new CustomEvent(name));
  }

  subscribe(name, handler) {
    this.eventTarget.addEventListener(name, handler);
    return () => this.eventTarget.removeEventListener(name, handler);
  }
}

const dataLayer = new DataLayer();

const state = {
  activeScreen: 'chats',
  activeProfileId: null,
  activeChatId: null,
  replyingTo: null,
  editingMessageId: null,
  searchCategory: 'posts',
  searchQuery: '',
  reduceMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};

const UI = {
  topTitle: q('#topTitle'),
  backButton: q('#backButton'),
  topAction: q('#topAction'),
  main: q('#main'),
  screens: {
    chats: q('#screen-chats'),
    chat: q('#screen-chat'),
    feed: q('#screen-feed'),
    video: q('#screen-video'),
    photo: q('#screen-photo'),
    search: q('#screen-search'),
    profile: q('#screen-profile'),
  },
  nav: q('.bottom-nav'),
  dev: {
    panel: q('#devPanel'),
    backdrop: q('#devBackdrop'),
    close: q('#closeDev'),
    tabs: q('.dev-panel__tabs'),
    tabButtons: qa('.dev-panel__tabs button'),
    content: q('#devContent'),
    tableSelect: q('#devTable'),
    filterInput: q('#devFilter'),
    refresh: q('#devRefresh'),
    data: q('#devData'),
    editor: q('#devEditor'),
    importBtn: q('#devImport'),
    exportBtn: q('#devExport'),
    applyBtn: q('#devApply'),
    logs: q('#devLogs'),
    resetBtn: q('#devReset'),
    reduceMotion: q('#reduceMotion'),
  },
};

const formatTime = (ts) => {
  const date = new Date(ts);
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

const formatDate = (ts) => {
  const date = new Date(ts);
  return date.toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' });
};

const generateId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

async function loadState() {
  const profiles = await dataLayer.getAll('profiles');
  const activeProfile = profiles.find((p) => p.active) || profiles[0];
  state.activeProfileId = activeProfile?.id;
  renderNav();
  await renderScreen(state.activeScreen);
  UI.dev.tableSelect.innerHTML = STORES.map((store) => `<option value="${store}">${store}</option>`).join('');
  await refreshDevData();
  updateReduceMotionToggle();
}

function renderNav() {
  qa('.nav-item').forEach((btn) => {
    const isActive = btn.dataset.target === state.activeScreen;
    btn.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}

async function renderScreen(screen) {
  Object.entries(UI.screens).forEach(([name, el]) => {
    const visible = name === screen;
    el.setAttribute('aria-hidden', String(!visible));
  });
  switch (screen) {
    case 'chats':
      UI.topTitle.textContent = 'Чаты';
      UI.backButton.dataset.visible = 'false';
      UI.topAction.dataset.visible = 'false';
      await renderChats();
      break;
    case 'chat':
      UI.topTitle.textContent = getActiveChatTitle();
      UI.backButton.dataset.visible = 'true';
      UI.topAction.dataset.visible = 'false';
      await renderChat();
      break;
    case 'feed':
      UI.topTitle.textContent = 'Лента';
      UI.backButton.dataset.visible = 'false';
      UI.topAction.dataset.visible = 'true';
      UI.topAction.onclick = () => openCreatePost();
      await renderFeed();
      break;
    case 'video':
      UI.topTitle.textContent = 'Видео';
      UI.backButton.dataset.visible = 'false';
      UI.topAction.dataset.visible = 'false';
      await renderVideo();
      break;
    case 'photo':
      UI.topTitle.textContent = 'Фото';
      UI.backButton.dataset.visible = 'false';
      UI.topAction.dataset.visible = 'false';
      await renderPhoto();
      break;
    case 'search':
      UI.topTitle.textContent = 'Поиск';
      UI.backButton.dataset.visible = 'false';
      UI.topAction.dataset.visible = 'false';
      await renderSearch();
      break;
    case 'profile':
      UI.topTitle.textContent = 'Профиль';
      UI.backButton.dataset.visible = 'false';
      UI.topAction.dataset.visible = 'false';
      await renderProfile();
      break;
    default:
      break;
  }
}

async function renderChats() {
  const container = UI.screens.chats;
  const profileId = state.activeProfileId;
  const chats = await dataLayer.getAll('chats');
  const messages = await dataLayer.getAll('messages');
  const filtered = chats
    .filter((chat) => chat.participants.includes(profileId) || chat.type === 'channel')
    .map((chat) => {
      const lastMessage = messages.find((m) => m.id === chat.lastMessageId) || null;
      return { ...chat, lastMessage };
    })
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return (b.lastMessage?.time || 0) - (a.lastMessage?.time || 0);
    });

  container.innerHTML = filtered
    .map((chat) => {
      const initials = escapeHTML(chat.title.slice(0, 2).toUpperCase());
      const snippet = chat.lastMessage?.deleted
        ? 'Удалено'
        : escapeHTML(chat.lastMessage?.text || 'Нет сообщений');
      const timeLabel = chat.lastMessage ? formatTime(chat.lastMessage.time) : '';
      return `
        <article class="card chat-card" data-chat-id="${chat.id}" tabindex="0">
          <div class="avatar">${initials}</div>
          <div>
            <div class="text-strong">${escapeHTML(chat.title)}</div>
            <div class="text-muted" aria-label="Последнее сообщение">${snippet}</div>
          </div>
          <div class="chat-meta">
            <time class="text-muted">${timeLabel}</time>
            ${chat.pinned ? '<svg><use href="icons.svg#pin"></use></svg>' : ''}
          </div>
          <div class="chat-actions" hidden>
            <button data-action="archive" aria-label="Архивировать чат">Архив</button>
            <button data-action="pin" aria-label="Закрепить чат">Пин</button>
            <button data-action="delete" aria-label="Удалить чат">Del</button>
          </div>
        </article>
      `;
    })
    .join('');

  qa('.chat-card', container).forEach((card) => {
    setupSwipe(card);
  });
}

function setupSwipe(card) {
  let startX = 0;
  let currentX = 0;
  let isSwiping = false;
  const actions = card.querySelector('.chat-actions');
  card.style.touchAction = 'pan-y';
  card.addEventListener('pointerdown', (event) => {
    startX = event.clientX;
    currentX = startX;
    isSwiping = true;
    card.setPointerCapture(event.pointerId);
    actions.hidden = false;
    actions.style.opacity = '0';
  });
  card.addEventListener('pointermove', (event) => {
    if (!isSwiping) return;
    currentX = event.clientX;
    const delta = currentX - startX;
    card.style.transform = `translateX(${delta}px)`;
    actions.style.opacity = `${Math.min(Math.abs(delta) / 100, 1)}`;
  });
  card.addEventListener('pointerup', (event) => {
    if (!isSwiping) return;
    const delta = currentX - startX;
    card.releasePointerCapture(event.pointerId);
    isSwiping = false;
    card.style.transform = '';
    actions.style.opacity = '';
    actions.hidden = true;
    if (delta > 90) {
      handleChatQuickAction(card.dataset.chatId, 'pin');
    } else if (delta < -90) {
      handleChatQuickAction(card.dataset.chatId, 'delete');
    }
  });
  card.addEventListener('pointercancel', () => {
    if (!isSwiping) return;
    isSwiping = false;
    card.style.transform = '';
    actions.style.opacity = '';
    actions.hidden = true;
  });
  card.addEventListener('click', () => openChat(card.dataset.chatId));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openChat(card.dataset.chatId);
  });
  actions.addEventListener('click', (event) => {
    const action = event.target?.dataset?.action;
    if (!action) return;
    event.stopPropagation();
    handleChatQuickAction(card.dataset.chatId, action);
  });
}

function getActiveChatTitle() {
  const card = qa('.chat-card').find((el) => el.dataset.chatId === state.activeChatId);
  if (card) {
    return card.querySelector('.text-strong')?.textContent || 'Чат';
  }
  return 'Чат';
}

async function renderChat() {
  const container = UI.screens.chat;
  const chatId = state.activeChatId;
  if (!chatId) return;
  const chat = await dataLayer.get('chats', chatId);
  if (!chat) return;
  const messages = await dataLayer.getAll('messages', 'by_chat', chatId);
  messages.sort((a, b) => a.time - b.time);
  const messageMap = new Map(messages.map((msg) => [msg.id, msg]));

  container.innerHTML = `
    <section class="message-list" id="messageList">
      ${messages
        .map((message) => {
          const own = message.senderProfileId === state.activeProfileId;
          const content = message.deleted
            ? '<span class="text-muted">Сообщение удалено</span>'
            : escapeHTML(message.text);
          const reply = message.replyTo ? messageMap.get(message.replyTo) : null;
          return `
            <article class="message ${own ? 'message--own' : ''}" data-message-id="${message.id}" tabindex="0">
              ${reply ? `<div class="message__reply">↳ ${escapeHTML(reply.text.slice(0, 60))}</div>` : ''}
              <div>${content}</div>
              <div class="message__meta">${formatTime(message.time)}${
                message.edited ? ' · ред.' : ''
              }</div>
              <button class="icon-button message__menu" aria-label="Опции сообщения">
                <svg><use href="icons.svg#more"></use></svg>
              </button>
            </article>
          `;
        })
        .join('')}
    </section>
  `;

  let composer = q('.composer');
  if (!composer) {
    composer = document.createElement('form');
    composer.className = 'composer';
    composer.innerHTML = `
      <div class="composer__reply" hidden>
        <span id="composerReply"></span>
        <button type="button" id="cancelReply">×</button>
      </div>
      <textarea id="composerInput" rows="1" placeholder="Сообщение" aria-label="Поле ввода сообщения"></textarea>
      <button type="submit" aria-label="Отправить">Send</button>
    `;
    document.body.appendChild(composer);
    const textarea = q('#composerInput', composer);
    const cancelReply = q('#cancelReply', composer);
    textarea.addEventListener('input', autoResizeTextarea);
    composer.addEventListener('submit', onSendMessage);
    cancelReply.addEventListener('click', () => {
      state.replyingTo = null;
      state.editingMessageId = null;
      q('.composer__reply', composer).hidden = true;
      textarea.value = '';
      autoResizeTextarea({ target: textarea });
    });
  }
  composer.dataset.chatId = chatId;
  const replyBadge = q('.composer__reply', composer);
  replyBadge.hidden = !state.replyingTo && !state.editingMessageId;
  if (state.replyingTo) {
    q('#composerReply', composer).textContent = `Ответ на: ${state.replyingTo.text.slice(0, 40)}`;
  } else if (state.editingMessageId) {
    const editing = messages.find((m) => m.id === state.editingMessageId);
    if (editing) {
      q('#composerReply', composer).textContent = `Редактирование: ${editing.text.slice(0, 40)}`;
      const textarea = q('#composerInput', composer);
      textarea.value = editing.text;
      autoResizeTextarea({ target: textarea });
    }
  } else {
    const textarea = q('#composerInput', composer);
    textarea.value = '';
    autoResizeTextarea({ target: textarea });
  }

  qa('.message', container).forEach((messageEl) => {
    const messageId = messageEl.dataset.messageId;
    const menuBtn = messageEl.querySelector('.message__menu');
    menuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openMessageMenu(messageId, messageEl);
    });
  });

  container.scrollTop = container.scrollHeight;
}

function autoResizeTextarea(event) {
  const el = event.target;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 44 * 3)}px`;
}

async function onSendMessage(event) {
  event.preventDefault();
  const textarea = q('#composerInput');
  const raw = sanitizeInput(textarea.value);
  if (!raw) return;
  const chatId = event.currentTarget.dataset.chatId;
  if (state.editingMessageId) {
    const existing = await dataLayer.get('messages', state.editingMessageId);
    if (existing) {
      await dataLayer.put('messages', {
        ...existing,
        text: raw,
        edited: true,
      });
    }
  } else {
    const message = {
      id: generateId('msg'),
      chatId,
      senderProfileId: state.activeProfileId,
      text: raw,
      attachments: [],
      replyTo: state.replyingTo?.id || null,
      time: Date.now(),
      edited: false,
      deleted: false,
    };
    await dataLayer.put('messages', message);
    await dataLayer.put('chats', {
      ...(await dataLayer.get('chats', chatId)),
      lastMessageId: message.id,
    });
  }
  state.replyingTo = null;
  state.editingMessageId = null;
  textarea.value = '';
  autoResizeTextarea({ target: textarea });
  await renderChat();
  await renderChats();
}

async function openChat(chatId) {
  state.activeChatId = chatId;
  state.activeScreen = 'chat';
  renderNav();
  await renderScreen('chat');
}

async function handleChatQuickAction(chatId, action) {
  const chat = await dataLayer.get('chats', chatId);
  if (!chat) return;
  if (action === 'delete') {
    await dataLayer.delete('chats', chatId);
    const messages = await dataLayer.getAll('messages', 'by_chat', chatId);
    await Promise.all(messages.map((msg) => dataLayer.delete('messages', msg.id)));
  }
  if (action === 'pin') {
    await dataLayer.put('chats', { ...chat, pinned: !chat.pinned });
  }
  if (action === 'archive') {
    await dataLayer.put('chats', { ...chat, archived: !chat.archived });
  }
  renderChats();
}

function openMessageMenu(messageId, anchorEl) {
  let sheet = q('#messageSheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'messageSheet';
    sheet.className = 'bottom-sheet';
    sheet.innerHTML = `
      <div class="context-menu">
        <button data-action="reply"><svg><use href="icons.svg#reply"></use></svg> Ответить</button>
        <button data-action="edit"><svg><use href="icons.svg#edit"></use></svg> Редактировать</button>
        <button data-action="copy"><svg><use href="icons.svg#copy"></use></svg> Копировать</button>
        <button data-action="delete"><svg><use href="icons.svg#delete"></use></svg> Удалить</button>
      </div>
    `;
    document.body.appendChild(sheet);
  }
  sheet.classList.add('active');
  sheet.dataset.messageId = messageId;
  sheet.onclick = async (event) => {
    const action = event.target?.closest('button')?.dataset?.action;
    if (!action) return;
    const message = await dataLayer.get('messages', sheet.dataset.messageId);
    if (!message) return;
    const composer = q('.composer');
    switch (action) {
      case 'reply':
        state.replyingTo = message;
        state.editingMessageId = null;
        if (composer) {
          q('.composer__reply', composer).hidden = false;
          q('#composerReply', composer).textContent = `Ответ на: ${message.text.slice(0, 40)}`;
        }
        break;
      case 'edit':
        state.editingMessageId = message.id;
        state.replyingTo = null;
        if (composer) {
          q('.composer__reply', composer).hidden = false;
          q('#composerReply', composer).textContent = `Редактирование: ${message.text.slice(0, 40)}`;
          const textarea = q('#composerInput', composer);
          textarea.value = message.text;
          autoResizeTextarea({ target: textarea });
        }
        break;
      case 'copy':
        try {
          await navigator.clipboard.writeText(message.text);
        } catch (error) {
          console.warn('Clipboard unavailable', error);
        }
        break;
      case 'delete':
        await dataLayer.put('messages', { ...message, deleted: true });
        break;
      default:
        break;
    }
    sheet.classList.remove('active');
    renderChat();
  };
  document.addEventListener(
    'click',
    function closeSheet(event) {
      if (!sheet.contains(event.target)) {
        sheet.classList.remove('active');
        document.removeEventListener('click', closeSheet);
      }
    },
    { once: true }
  );
}

async function renderFeed() {
  const container = UI.screens.feed;
  const posts = await dataLayer.getAll('posts');
  const profiles = await dataLayer.getAll('profiles');
  const likes = await dataLayer.getAll('likes');
  const comments = await dataLayer.getAll('comments');
  posts.sort((a, b) => b.time - a.time);
  container.innerHTML = posts
    .map((post) => {
      const author = profiles.find((p) => p.id === post.authorProfileId);
      const liked = likes.some((like) => like.postId === post.id && like.profileId === state.activeProfileId);
      const counters = {
        likes: likes.filter((l) => l.postId === post.id).length,
        comments: comments.filter((c) => c.postId === post.id).length,
      };
      return `
        <article class="card feed-card" data-post-id="${post.id}">
          <header class="feed-card__header">
            <div class="avatar">${escapeHTML(author?.handle?.slice(0, 2) || 'PR')}</div>
            <div>
              <div>${escapeHTML(author?.handle || 'profile')}</div>
              <time class="text-muted">${formatDate(post.time)}</time>
            </div>
          </header>
          <div>${escapeHTML(post.content)}</div>
          ${post.media?.[0] ? `<div class="media-thumb">${escapeHTML(post.media[0].src)}</div>` : ''}
          <footer class="feed-card__actions">
            <button data-action="like" aria-pressed="${liked}">
              <svg><use href="icons.svg#like"></use></svg>${counters.likes}
            </button>
            <button data-action="repost">
              <svg><use href="icons.svg#repost"></use></svg>
            </button>
            <button data-action="comment">
              <svg><use href="icons.svg#comment"></use></svg>${counters.comments}
            </button>
            <button data-action="share">
              <svg><use href="icons.svg#share"></use></svg>
            </button>
          </footer>
        </article>
      `;
    })
    .join('');
  container.onclick = onFeedAction;
}

async function onFeedAction(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const card = event.target.closest('.feed-card');
  if (!card) return;
  const postId = card.dataset.postId;
  const action = btn.dataset.action;
  if (action === 'like') {
    const likes = await dataLayer.getAll('likes');
    const existing = likes.find((l) => l.postId === postId && l.profileId === state.activeProfileId);
    if (existing) {
      await dataLayer.delete('likes', existing.id);
    } else {
      await dataLayer.put('likes', {
        id: generateId('like'),
        postId,
        profileId: state.activeProfileId,
        time: Date.now(),
      });
    }
    renderFeed();
  }
  if (action === 'comment') {
    openCommentSheet(postId);
  }
  if (action === 'share') {
    alert('Поделиться доступно в полной версии.');
  }
  if (action === 'repost') {
    alert('Репост сохранён локально.');
  }
}

async function openCommentSheet(postId) {
  let sheet = q('#commentSheet');
  if (!sheet) {
    sheet = document.createElement('form');
    sheet.id = 'commentSheet';
    sheet.className = 'bottom-sheet';
    sheet.innerHTML = `
      <div class="context-menu">
        <label>Комментарий<textarea name="comment" rows="3" required></textarea></label>
        <button type="submit">Сохранить</button>
      </div>
    `;
    document.body.appendChild(sheet);
    sheet.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = sanitizeInput(new FormData(sheet).get('comment'));
      if (!text) return;
      await dataLayer.put('comments', {
        id: generateId('cm'),
        postId: sheet.dataset.postId,
        authorProfileId: state.activeProfileId,
        text,
        time: Date.now(),
      });
      sheet.classList.remove('active');
      renderFeed();
    });
  }
  sheet.dataset.postId = postId;
  sheet.classList.add('active');
  document.addEventListener(
    'click',
    function closeSheet(event) {
      if (!sheet.contains(event.target)) {
        sheet.classList.remove('active');
        document.removeEventListener('click', closeSheet);
      }
    },
    { once: true }
  );
}

async function openCreatePost() {
  let sheet = q('#postSheet');
  if (!sheet) {
    sheet = document.createElement('form');
    sheet.id = 'postSheet';
    sheet.className = 'bottom-sheet active';
    sheet.innerHTML = `
      <div class="context-menu">
        <label>Тип
          <select name="type">
            <option value="text">Текст</option>
            <option value="photo">Фото</option>
            <option value="video">Видео</option>
          </select>
        </label>
        <label>Контент<textarea name="content" rows="4" required></textarea></label>
        <label>Медиа ID<input name="media" placeholder="mock-id"></label>
        <button type="submit">Создать</button>
      </div>
    `;
    document.body.appendChild(sheet);
    sheet.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(sheet);
      const type = formData.get('type');
      const content = sanitizeInput(formData.get('content'));
      const mediaId = sanitizeInput(formData.get('media'));
      if (!content) return;
      const post = {
        id: generateId('post'),
        authorProfileId: state.activeProfileId,
        type,
        content,
        media: mediaId ? [{ kind: type, src: mediaId }] : [],
        time: Date.now(),
        likesCount: 0,
      };
      await dataLayer.put('posts', post);
      sheet.classList.remove('active');
      renderFeed();
    });
  } else {
    sheet.classList.add('active');
  }
  document.addEventListener(
    'click',
    function closeSheet(event) {
      if (!sheet.contains(event.target)) {
        sheet.classList.remove('active');
        document.removeEventListener('click', closeSheet);
      }
    },
    { once: true }
  );
}

async function renderVideo() {
  const container = UI.screens.video;
  const posts = await dataLayer.getAll('posts', 'by_type', 'video');
  posts.sort((a, b) => b.time - a.time);
  container.innerHTML = posts
    .map(
      (post) => `
      <article class="card" data-video-id="${post.id}">
        <div class="media-thumb">${escapeHTML(post.media?.[0]?.src || 'video')}</div>
        <div>${escapeHTML(post.content)}</div>
        <button data-action="play">Смотреть</button>
      </article>
    `
    )
    .join('');
  container.onclick = (event) => {
    const card = event.target.closest('[data-video-id]');
    if (!card) return;
    if (event.target.dataset.action === 'play') {
      openVideoViewer(card.dataset.videoId);
    }
  };
}

async function openVideoViewer(postId) {
  let viewer = q('#videoViewer');
  if (!viewer) {
    viewer = document.createElement('section');
    viewer.id = 'videoViewer';
    viewer.className = 'video-viewer';
    viewer.innerHTML = `
      <div class="video-player">
        <span id="videoMock"></span>
      </div>
      <div class="video-controls">
        <button id="videoClose">Закрыть</button>
        <button id="videoLike">Лайк</button>
      </div>
      <div class="video-comments" id="videoComments"></div>
    `;
    document.body.appendChild(viewer);
    q('#videoClose', viewer).addEventListener('click', () => viewer.classList.remove('active'));
  }
  const post = await dataLayer.get('posts', postId);
  const comments = (await dataLayer.getAll('comments', 'by_post', postId)) || [];
  const likes = await dataLayer.getAll('likes');
  q('#videoMock', viewer).textContent = post.media?.[0]?.src || 'Видео';
  q('#videoComments', viewer).innerHTML = comments
    .map((comment) => `<p>${escapeHTML(comment.text)}<br><small>${formatTime(comment.time)}</small></p>`)
    .join('');
  const likeBtn = q('#videoLike', viewer);
  const liked = likes.some((l) => l.postId === postId && l.profileId === state.activeProfileId);
  likeBtn.textContent = liked ? 'Убрать лайк' : 'Лайк';
  likeBtn.onclick = async () => {
    const freshLikes = await dataLayer.getAll('likes');
    const existing = freshLikes.find((l) => l.postId === postId && l.profileId === state.activeProfileId);
    if (existing) {
      await dataLayer.delete('likes', existing.id);
    } else {
      await dataLayer.put('likes', {
        id: generateId('like'),
        postId,
        profileId: state.activeProfileId,
        time: Date.now(),
      });
    }
    const updatedLikes = await dataLayer.getAll('likes');
    const likedNow = updatedLikes.some((l) => l.postId === postId && l.profileId === state.activeProfileId);
    likeBtn.textContent = likedNow ? 'Убрать лайк' : 'Лайк';
    renderFeed();
  };
  viewer.classList.add('active');
}

async function renderPhoto() {
  const container = UI.screens.photo;
  const posts = await dataLayer.getAll('posts', 'by_type', 'photo');
  posts.sort((a, b) => b.time - a.time);
  container.innerHTML = `
    <div class="photo-grid">
      ${posts
        .map((post) => `
          <button class="photo-grid__item" data-post-id="${post.id}">
            <span>${escapeHTML(post.media?.[0]?.src || 'photo')}</span>
          </button>
        `)
        .join('')}
    </div>
  `;
  container.onclick = (event) => {
    const btn = event.target.closest('[data-post-id]');
    if (!btn) return;
    openLightbox(btn.dataset.postId);
  };
}

async function openLightbox(postId) {
  let lightbox = q('#lightbox');
  if (!lightbox) {
    lightbox = document.createElement('section');
    lightbox.id = 'lightbox';
    lightbox.className = 'lightbox';
    lightbox.innerHTML = `
      <div class="lightbox__image" id="lightboxImage"></div>
    `;
    document.body.appendChild(lightbox);
    lightbox.addEventListener('click', () => lightbox.classList.remove('active'));
  }
  const post = await dataLayer.get('posts', postId);
  q('#lightboxImage').textContent = post.media?.[0]?.src || 'photo';
  lightbox.classList.add('active');
}

async function renderSearch() {
  const container = UI.screens.search;
  container.innerHTML = `
    <div class="search-header">
      <input type="search" id="searchInput" placeholder="Поиск или dev:1234" value="${escapeHTML(state.searchQuery)}" aria-label="Строка поиска">
      <div class="search-categories" role="tablist">
        ${['people', 'posts', 'videos', 'photos', 'chats']
          .map(
            (cat) => `
              <button role="tab" data-cat="${cat}" aria-pressed="${state.searchCategory === cat}">
                ${cat.toUpperCase()}
              </button>
            `
          )
          .join('')}
      </div>
    </div>
    <div id="searchResults"></div>
  `;
  const input = q('#searchInput', container);
  input.addEventListener('input', async (event) => {
    const value = event.target.value;
    state.searchQuery = value;
    if (value.startsWith(DEV_CODE)) {
      openDevPanel();
      state.searchQuery = '';
      event.target.value = '';
      await renderSearchResults();
    } else {
      await renderSearchResults();
    }
  });
  qa('[data-cat]', container).forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.searchCategory = btn.dataset.cat;
      qa('[data-cat]', container).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      await renderSearchResults();
    });
  });
  await renderSearchResults();
}

async function renderSearchResults() {
  const resultsContainer = q('#searchResults');
  const term = state.searchQuery.toLowerCase();
  const cat = state.searchCategory;
  let results = [];
  if (!term) {
    resultsContainer.innerHTML = '<p class="text-muted">Начните ввод для поиска.</p>';
    return;
  }
  switch (cat) {
    case 'people': {
      const users = await dataLayer.getAll('users');
      results = users.filter((user) => user.name.toLowerCase().includes(term));
      resultsContainer.innerHTML = results
        .map((user) => `<div class="card">${escapeHTML(user.name)}<br><span class="text-muted">${escapeHTML(user.bio || '')}</span></div>`)
        .join('');
      break;
    }
    case 'posts': {
      const posts = await dataLayer.getAll('posts');
      results = posts.filter((post) => post.content.toLowerCase().includes(term));
      resultsContainer.innerHTML = results
        .map((post) => `<div class="card">${escapeHTML(post.content)}</div>`)
        .join('');
      break;
    }
    case 'videos': {
      const posts = await dataLayer.getAll('posts', 'by_type', 'video');
      results = posts.filter((post) => post.content.toLowerCase().includes(term));
      resultsContainer.innerHTML = results
        .map((post) => `<div class="card">Видео: ${escapeHTML(post.content)}</div>`)
        .join('');
      break;
    }
    case 'photos': {
      const posts = await dataLayer.getAll('posts', 'by_type', 'photo');
      results = posts.filter((post) => post.content.toLowerCase().includes(term));
      resultsContainer.innerHTML = results
        .map((post) => `<div class="card">Фото: ${escapeHTML(post.content)}</div>`)
        .join('');
      break;
    }
    case 'chats': {
      const chats = await dataLayer.getAll('chats');
      results = chats.filter((chat) => chat.title.toLowerCase().includes(term));
      resultsContainer.innerHTML = results
        .map((chat) => `<div class="card">Чат: ${escapeHTML(chat.title)}</div>`)
        .join('');
      break;
    }
    default:
      resultsContainer.innerHTML = '<p>Нет результатов</p>';
  }
}

async function renderProfile() {
  const container = UI.screens.profile;
  const users = await dataLayer.getAll('users');
  const profiles = await dataLayer.getAll('profiles');
  const activeProfile = profiles.find((p) => p.id === state.activeProfileId);
  const user = users.find((u) => u.id === activeProfile?.userId);
  container.innerHTML = `
    <section class="card profile-card">
      <div class="avatar">${escapeHTML(user?.name?.slice(0, 2) || 'ME')}</div>
      <div>
        <h2>${escapeHTML(user?.name || 'Профиль')}</h2>
        <p class="text-muted">${escapeHTML(user?.bio || '')}</p>
      </div>
    </section>
    <section class="profile-switcher">
      ${profiles
        .map(
          (profile) => `
            <button data-profile-id="${profile.id}" aria-pressed="${profile.id === state.activeProfileId}">
              ${escapeHTML(profile.handle || profile.id)}
            </button>
          `
        )
        .join('')}
    </section>
    <div class="self-chat">
      <span>Self-chat</span>
      <button id="openSelfChat">Открыть</button>
    </div>
  `;
  qa('[data-profile-id]', container).forEach((btn) => {
    btn.addEventListener('click', async () => {
      await setActiveProfile(btn.dataset.profileId);
    });
  });
  q('#openSelfChat', container)?.addEventListener('click', async () => {
    const chats = await dataLayer.getAll('chats');
    let chat = chats.find((c) => c.participants.length === 1 && c.participants[0] === state.activeProfileId);
    if (!chat) {
      chat = {
        id: generateId('chat'),
        type: 'personal',
        title: 'Сам себе',
        participants: [state.activeProfileId],
        pinned: true,
        archived: false,
        lastMessageId: null,
      };
      await dataLayer.put('chats', chat);
    }
    openChat(chat.id);
  });
}

async function setActiveProfile(profileId) {
  const profiles = await dataLayer.getAll('profiles');
  await dataLayer.bulkPut(
    'profiles',
    profiles.map((profile) => ({ ...profile, active: profile.id === profileId }))
  );
  state.activeProfileId = profileId;
  await renderScreen(state.activeScreen);
}

function renderDevPanelTabs(activeTab) {
  UI.dev.tabButtons.forEach((btn) => {
    const isActive = btn.dataset.tab === activeTab;
    btn.setAttribute('aria-selected', isActive);
    const tab = q(`.dev-tab[data-tab="${btn.dataset.tab}"]`);
    tab.classList.toggle('active', isActive);
  });
}

async function refreshDevData() {
  const store = UI.dev.tableSelect.value || 'profiles';
  const filter = (UI.dev.filterInput.value || '').toLowerCase();
  const data = await dataLayer.getAll(store);
  const filtered = filter
    ? data.filter((item) => JSON.stringify(item).toLowerCase().includes(filter))
    : data;
  UI.dev.data.textContent = JSON.stringify(filtered, null, 2);
  const logs = await dataLayer.getAll('logs');
  logs.sort((a, b) => b.time - a.time);
  UI.dev.logs.textContent = logs
    .map((log) => `${new Date(log.time).toISOString()} :: ${log.action} :: ${JSON.stringify(log.payload)}`)
    .join('\n');
}

async function openDevPanel() {
  UI.dev.panel.classList.add('active');
  UI.dev.panel.setAttribute('aria-hidden', 'false');
  UI.dev.backdrop.hidden = false;
  await refreshDevData();
}

function closeDevPanel() {
  UI.dev.panel.classList.remove('active');
  UI.dev.panel.setAttribute('aria-hidden', 'true');
  UI.dev.backdrop.hidden = true;
}

function updateReduceMotionToggle() {
  UI.dev.reduceMotion.checked = state.reduceMotion;
  document.body.classList.toggle('reduced-motion', state.reduceMotion);
}

async function initDevPanel() {
  UI.dev.close.addEventListener('click', closeDevPanel);
  UI.dev.backdrop.addEventListener('click', closeDevPanel);
  UI.dev.tabs.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-tab]');
    if (!btn) return;
    renderDevPanelTabs(btn.dataset.tab);
  });
  UI.dev.tableSelect.addEventListener('change', refreshDevData);
  UI.dev.filterInput.addEventListener('input', refreshDevData);
  UI.dev.refresh.addEventListener('click', refreshDevData);
  UI.dev.exportBtn.addEventListener('click', async () => {
    const data = {};
    for (const store of STORES) {
      data[store] = await dataLayer.getAll(store);
    }
    UI.dev.editor.value = JSON.stringify(data, null, 2);
  });
  UI.dev.importBtn.addEventListener('click', () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json';
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const text = await file.text();
      UI.dev.editor.value = text;
    });
    fileInput.click();
  });
  UI.dev.applyBtn.addEventListener('click', async () => {
    try {
      const payload = JSON.parse(UI.dev.editor.value);
      for (const store of Object.keys(payload)) {
        if (!STORES.includes(store)) continue;
        await dataLayer.bulkPut(store, payload[store]);
      }
      await refreshDevData();
    } catch (error) {
      alert('Некорректный JSON');
    }
  });
  UI.dev.resetBtn.addEventListener('click', async () => {
    if (!confirm('Сбросить базу?')) return;
    await dataLayer.clearAll();
    await dataLayer.seed();
    await refreshDevData();
    await renderScreen(state.activeScreen);
  });
  UI.dev.reduceMotion.addEventListener('change', () => {
    state.reduceMotion = UI.dev.reduceMotion.checked;
    updateReduceMotionToggle();
    localStorage.setItem('mono-reduced-motion', state.reduceMotion ? '1' : '0');
  });
}

function initNav() {
  UI.nav.addEventListener('click', async (event) => {
    const btn = event.target.closest('.nav-item');
    if (!btn) return;
    state.activeScreen = btn.dataset.target;
    renderNav();
    await renderScreen(state.activeScreen);
  });
  UI.backButton.addEventListener('click', async () => {
    if (state.activeScreen === 'chat') {
      state.activeScreen = 'chats';
      renderNav();
      await renderScreen('chats');
    }
  });
}

function restorePreferences() {
  const stored = localStorage.getItem('mono-reduced-motion');
  if (stored === '1') {
    state.reduceMotion = true;
  }
  updateReduceMotionToggle();
}

async function init() {
  await dataLayer.open();
  restorePreferences();
  initNav();
  await initDevPanel();
  await loadState();
}

document.addEventListener('DOMContentLoaded', init);
