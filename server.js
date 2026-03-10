// index.js - Arquivo principal do Worker

// ==================== CONFIGURAÇÃO ====================
const ADMIN_USERNAME = 'klord';
const ADMIN_PASSWORD = 'Kl0rd777';

// ==================== DURABLE OBJECT - BANCO DE DADOS ====================
export class IPTVDatabase {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Inicializar dados se não existirem
    await this.initialize();

    if (path === '/get-users') {
      const users = await this.state.storage.get('users') || [];
      return new Response(JSON.stringify(users), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/get-settings') {
      const settings = await this.state.storage.get('settings');
      return new Response(JSON.stringify(settings), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/save-user') {
      const data = await request.json();
      let users = await this.state.storage.get('users') || [];
      
      if (data.action === 'create') {
        users.push(data.user);
      } else if (data.action === 'update') {
        const idx = users.findIndex(u => u.id === data.user.id);
        if (idx !== -1) users[idx] = { ...users[idx], ...data.updates };
      } else if (data.action === 'delete') {
        users = users.filter(u => u.id !== data.userId);
      }
      
      await this.state.storage.put('users', users);
      return new Response(JSON.stringify({ success: true, users }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/save-settings') {
      const settings = await request.json();
      await this.state.storage.put('settings', settings);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/validate-token') {
      const { token } = await request.json();
      const tokens = await this.state.storage.get('tokens') || new Set();
      const isValid = tokens.has(token);
      return new Response(JSON.stringify({ valid: isValid }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/add-token') {
      const { token } = await request.json();
      let tokens = await this.state.storage.get('tokens') || new Set();
      tokens = new Set(tokens);
      tokens.add(token);
      await this.state.storage.put('tokens', Array.from(tokens));
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path === '/remove-token') {
      const { token } = await request.json();
      let tokens = await this.state.storage.get('tokens') || new Set();
      tokens = new Set(tokens);
      tokens.delete(token);
      await this.state.storage.put('tokens', Array.from(tokens));
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async initialize() {
    const existing = await this.state.storage.get('initialized');
    if (!existing) {
      // Criar admin padrão
      const adminUser = {
        id: 'admin',
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD,
        isAdmin: true,
        createdAt: new Date().toISOString(),
        expiresAt: 'never',
        maxConnections: 999,
        activeConnections: 0,
        status: 'Active',
        notes: 'Administrador do sistema'
      };
      
      await this.state.storage.put('users', [adminUser]);
      await this.state.storage.put('settings', {
        serverName: 'Meu Servidor IPTV',
        maxConcurrentConnections: 1000,
        defaultExpiryDays: 30,
        defaultMaxConnections: 1
      });
      await this.state.storage.put('tokens', []);
      await this.state.storage.put('initialized', true);
      console.log('Banco de dados inicializado com admin:', ADMIN_USERNAME);
    }
  }
}

// ==================== WORKER PRINCIPAL ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE, PUT',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Referência ao Durable Object
    const id = env.IPTV_DATABASE.idFromName('main');
    const db = env.IPTV_DATABASE.get(id);

    // ==================== API IPTV (Xtream Codes) ====================
    if (path === '/player_api.php') {
      return handlePlayerAPI(request, db, url);
    }

    // Streaming endpoints
    if (path.startsWith('/live/')) {
      return handleLiveStream(request, db, path);
    }
    if (path.startsWith('/movie/')) {
      return handleMovieStream(request, db, path);
    }
    if (path.startsWith('/series/')) {
      return handleSeriesStream(request, db, path);
    }

    // ==================== PAINEL ADMINISTRATIVO ====================
    if (path === '/admin' || path === '/admin/') {
      return new Response(getLoginHTML(), {
        headers: { 'Content-Type': 'text/html', ...corsHeaders }
      });
    }

    if (path === '/admin/dashboard') {
      return new Response(getDashboardHTML(), {
        headers: { 'Content-Type': 'text/html', ...corsHeaders }
      });
    }

    // API Admin
    if (path === '/admin/api/login') {
      return handleAdminLogin(request, db);
    }

    if (path === '/admin/api/stats') {
      return handleStats(request, db, corsHeaders);
    }

    if (path === '/admin/api/users') {
      return handleUsers(request, db, corsHeaders);
    }

    if (path.startsWith('/admin/api/users/')) {
      return handleUserDetail(request, db, corsHeaders, path);
    }

    if (path === '/admin/api/settings') {
      return handleSettings(request, db, corsHeaders);
    }

    // M3U Playlist
    if (path === '/get.php') {
      return handleM3U(request, db, url);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};

// ==================== FUNÇÕES AUXILIARES ====================

async function handlePlayerAPI(request, db, url) {
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  const action = url.searchParams.get('action');

  const usersResponse = await db.fetch(new Request('http://fake/get-users'));
  const users = await usersResponse.json();
  const user = users.find(u => u.username === username && u.password === password);

  if (!user) {
    return jsonResponse({ user_info: { auth: 0, status: 'Invalid' } });
  }

  if (isExpired(user)) {
    return jsonResponse({ 
      user_info: { 
        auth: 0, 
        status: 'Expired',
        message: 'Sua assinatura expirou'
      } 
    });
  }

  if (!action) {
    return jsonResponse({
      user_info: {
        username: user.username,
        password: user.password,
        message: '',
        auth: 1,
        status: user.status,
        exp_date: user.expiresAt === 'never' ? '1758143248' : Math.floor(new Date(user.expiresAt).getTime() / 1000).toString(),
        is_trial: '0',
        active_cons: user.activeConnections.toString(),
        created_at: Math.floor(new Date(user.createdAt).getTime() / 1000).toString(),
        max_connections: user.maxConnections.toString(),
        allowed_output_formats: ['m3u8', 'ts', 'mp4']
      },
      server_info: {
        url: url.hostname,
        port: '443',
        https_port: '443',
        server_protocol: 'https',
        rtmp_port: '0',
        timezone: 'America/Sao_Paulo',
        timestamp_now: Math.floor(Date.now() / 1000),
        time_now: new Date().toISOString().replace('T', ' ').substring(0, 19),
        process: true
      }
    });
  }

  // Ações específicas
  const playlist = await getPlaylistFromKV(request);
  
  if (action === 'get_live_categories') {
    return jsonResponse(playlist.categories.live);
  }
  if (action === 'get_vod_categories') {
    return jsonResponse(playlist.categories.vod);
  }
  if (action === 'get_series_categories') {
    return jsonResponse(playlist.categories.series);
  }
  if (action === 'get_live_streams') {
    const category_id = url.searchParams.get('category_id');
    let result = category_id ? playlist.live.filter(s => s.category_id === category_id) : playlist.live;
    return jsonResponse(result);
  }
  if (action === 'get_vod_streams') {
    const category_id = url.searchParams.get('category_id');
    let result = category_id ? playlist.vod.filter(s => s.category_id === category_id) : playlist.vod;
    return jsonResponse(result);
  }
  if (action === 'get_series') {
    const category_id = url.searchParams.get('category_id');
    let list = Object.values(playlist.series).map(s => ({
      series_id: s.series_id,
      name: s.name,
      cover: s.cover,
      plot: s.plot,
      cast: s.cast,
      director: s.director,
      genre: s.genre,
      releaseDate: s.releaseDate,
      last_modified: s.last_modified,
      category_id: s.category_id
    }));
    if (category_id) list = list.filter(s => s.category_id === category_id);
    return jsonResponse(list);
  }
  if (action === 'get_series_info') {
    const series_id = url.searchParams.get('series_id');
    const serie = Object.values(playlist.series).find(s => s.series_id === series_id);
    if (!serie) return jsonResponse({ seasons: [] });
    const seasons = Object.keys(serie.seasons).map(seasonNum => ({
      season_number: parseInt(seasonNum),
      episodes: serie.seasons[seasonNum].map(ep => ({
        id: ep.id,
        episode_num: ep.episode_num,
        title: ep.title,
        container_extension: ep.container_extension,
        info: ep.info
      }))
    }));
    return jsonResponse({ seasons });
  }
  if (action === 'get_vod_info') {
    const vod_id = url.searchParams.get('vod_id');
    const movie = playlist.vod.find(v => v.stream_id === vod_id);
    if (!movie) return jsonResponse({});
    return jsonResponse({
      info: {
        name: movie.name,
        stream_id: movie.stream_id,
        container_extension: movie.container_extension,
        stream_icon: movie.stream_icon,
        plot: '',
        cast: '',
        director: '',
        genre: '',
        releasedate: movie.releaseDate,
        duration_secs: 0,
        duration: ''
      },
      movie_data: {
        stream_id: movie.stream_id,
        name: movie.name,
        container_extension: movie.container_extension,
        stream_icon: movie.stream_icon,
        added: movie.added,
        direct_source: movie.direct_source
      }
    });
  }

  return jsonResponse({ error: 'Ação não suportada', action });
}

async function handleLiveStream(request, db, path) {
  const parts = path.split('/');
  const username = parts[2];
  const password = parts[3];
  const stream_id = parts[4].replace('.ts', '');

  const usersResponse = await db.fetch(new Request('http://fake/get-users'));
  const users = await usersResponse.json();
  const user = users.find(u => u.username === username && u.password === password);

  if (!user || isExpired(user)) {
    return new Response('Acesso negado', { status: 403 });
  }

  const playlist = await getPlaylistFromKV(request);
  const channel = playlist.live.find(c => c.stream_id === stream_id);
  
  if (channel && channel.direct_source) {
    return Response.redirect(channel.direct_source, 302);
  }
  
  return new Response('Stream não encontrado', { status: 404 });
}

async function handleMovieStream(request, db, path) {
  const parts = path.split('/');
  const username = parts[2];
  const password = parts[3];
  const stream_id = parts[4].replace('.mp4', '');

  const usersResponse = await db.fetch(new Request('http://fake/get-users'));
  const users = await usersResponse.json();
  const user = users.find(u => u.username === username && u.password === password);

  if (!user || isExpired(user)) {
    return new Response('Acesso negado', { status: 403 });
  }

  const playlist = await getPlaylistFromKV(request);
  const movie = playlist.vod.find(v => v.stream_id === stream_id);
  
  if (movie && movie.direct_source) {
    return Response.redirect(movie.direct_source, 302);
  }
  
  return new Response('Filme não encontrado', { status: 404 });
}

async function handleSeriesStream(request, db, path) {
  const parts = path.split('/');
  const username = parts[2];
  const password = parts[3];
  const stream_id = parts[4].replace('.mp4', '');

  const usersResponse = await db.fetch(new Request('http://fake/get-users'));
  const users = await usersResponse.json();
  const user = users.find(u => u.username === username && u.password === password);

  if (!user || isExpired(user)) {
    return new Response('Acesso negado', { status: 403 });
  }

  const playlist = await getPlaylistFromKV(request);
  
  for (let serieName in playlist.series) {
    const serie = playlist.series[serieName];
    for (let seasonNum in serie.seasons) {
      const ep = serie.seasons[seasonNum].find(e => e.id === stream_id);
      if (ep) {
        return Response.redirect(ep.url, 302);
      }
    }
  }
  
  return new Response('Episódio não encontrado', { status: 404 });
}

async function handleAdminLogin(request, db) {
  const { username, password } = await request.json();
  
  const usersResponse = await db.fetch(new Request('http://fake/get-users'));
  const users = await usersResponse.json();
  
  const user = users.find(u => u.username === username && u.password === password && u.isAdmin);
  
  if (user) {
    const token = generateId();
    await db.fetch(new Request('http://fake/add-token', {
      method: 'POST',
      body: JSON.stringify({ token })
    }));
    
    return jsonResponse({ 
      success: true, 
      token, 
      user: { username: user.username, isAdmin: true } 
    });
  }
  
  return jsonResponse({ success: false });
}

async function handleStats(request, db, corsHeaders) {
  const token = request.headers.get('Authorization');
  const validateResponse = await db.fetch(new Request('http://fake/validate-token', {
    method: 'POST',
    body: JSON.stringify({ token })
  }));
  const { valid } = await validateResponse.json();
  
  if (!valid) {
    return new Response('Não autorizado', { status: 401, headers: corsHeaders });
  }

  const usersResponse = await db.fetch(new Request('http://fake/get-users'));
  const users = await usersResponse.json();
  
  const totalUsers = users.length;
  const activeUsers = users.filter(u => !isExpired(u) && u.status === 'Active').length;
  const expiredUsers = users.filter(u => isExpired(u)).length;
  
  const recentUsers = [...users]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);

  const playlist = await getPlaylistFromKV(request);

  return jsonResponse({
    totalUsers,
    activeUsers,
    expiredUsers,
    content: {
      live: playlist.live.length,
      vod: playlist.vod.length,
      series: Object.keys(playlist.series).length
    },
    recentUsers
  }, corsHeaders);
}

async function handleUsers(request, db, corsHeaders) {
  const token = request.headers.get('Authorization');
  const validateResponse = await db.fetch(new Request('http://fake/validate-token', {
    method: 'POST',
    body: JSON.stringify({ token })
  }));
  const { valid } = await validateResponse.json();
  
  if (!valid) {
    return new Response('Não autorizado', { status: 401, headers: corsHeaders });
  }

  if (request.method === 'GET') {
    const usersResponse = await db.fetch(new Request('http://fake/get-users'));
    const users = await usersResponse.json();
    return jsonResponse(users.map(u => ({ ...u, isExpired: isExpired(u) })), corsHeaders);
  }

  if (request.method === 'POST') {
    const data = await request.json();
    const settingsResponse = await db.fetch(new Request('http://fake/get-settings'));
    const settings = await settingsResponse.json();
    
    const finalUsername = data.username || 'user' + Math.floor(Math.random() * 10000);
    const finalPassword = data.password || generatePassword();
    
    const usersResponse = await db.fetch(new Request('http://fake/get-users'));
    const users = await usersResponse.json();
    
    if (users.find(u => u.username === finalUsername)) {
      return jsonResponse({ success: false, error: 'Usuário já existe' }, corsHeaders);
    }

    const newUser = {
      id: generateId(),
      username: finalUsername,
      password: finalPassword,
      isAdmin: false,
      createdAt: new Date().toISOString(),
      expiresAt: data.expiryDays ? calculateExpiryDate(data.expiryDays) : 'never',
      maxConnections: data.maxConnections || settings.defaultMaxConnections,
      activeConnections: 0,
      status: 'Active',
      notes: data.notes || ''
    };

    await db.fetch(new Request('http://fake/save-user', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', user: newUser })
    }));

    return jsonResponse({ success: true, user: newUser }, corsHeaders);
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders });
}

async function handleUserDetail(request, db, corsHeaders, path) {
  const id = path.split('/').pop();
  
  const token = request.headers.get('Authorization');
  const validateResponse = await db.fetch(new Request('http://fake/validate-token', {
    method: 'POST',
    body: JSON.stringify({ token })
  }));
  const { valid } = await validateResponse.json();
  
  if (!valid) {
    return new Response('Não autorizado', { status: 401, headers: corsHeaders });
  }

  const usersResponse = await db.fetch(new Request('http://fake/get-users'));
  const users = await usersResponse.json();

  if (request.method === 'PUT') {
    const data = await request.json();
    const userIndex = users.findIndex(u => u.id === id);
    
    if (userIndex === -1) {
      return jsonResponse({ success: false, error: 'Usuário não encontrado' }, corsHeaders);
    }

    const updates = {};
    if (data.password) updates.password = data.password;
    if (data.expiresAt) updates.expiresAt = data.expiresAt;
    if (data.maxConnections) updates.maxConnections = data.maxConnections;
    if (data.status) updates.status = data.status;
    if (data.notes !== undefined) updates.notes = data.notes;

    await db.fetch(new Request('http://fake/save-user', {
      method: 'POST',
      body: JSON.stringify({ action: 'update', user: { id }, updates })
    }));

    return jsonResponse({ success: true }, corsHeaders);
  }

  if (request.method === 'DELETE') {
    const user = users.find(u => u.id === id);
    if (!user) {
      return jsonResponse({ success: false, error: 'Usuário não encontrado' }, corsHeaders);
    }
    if (user.isAdmin) {
      return jsonResponse({ success: false, error: 'Não pode deletar admin' }, corsHeaders);
    }

    await db.fetch(new Request('http://fake/save-user', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', userId: id })
    }));

    return jsonResponse({ success: true }, corsHeaders);
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders });
}

async function handleSettings(request, db, corsHeaders) {
  const token = request.headers.get('Authorization');
  const validateResponse = await db.fetch(new Request('http://fake/validate-token', {
    method: 'POST',
    body: JSON.stringify({ token })
  }));
  const { valid } = await validateResponse.json();
  
  if (!valid) {
    return new Response('Não autorizado', { status: 401, headers: corsHeaders });
  }

  if (request.method === 'PUT') {
    const data = await request.json();
    const settingsResponse = await db.fetch(new Request('http://fake/get-settings'));
    const currentSettings = await settingsResponse.json();
    
    const newSettings = {
      serverName: data.serverName || currentSettings.serverName,
      defaultExpiryDays: data.defaultExpiryDays || currentSettings.defaultExpiryDays,
      defaultMaxConnections: data.defaultMaxConnections || currentSettings.defaultMaxConnections
    };

    await db.fetch(new Request('http://fake/save-settings', {
      method: 'POST',
      body: JSON.stringify(newSettings)
    }));

    return jsonResponse({ success: true, settings: newSettings }, corsHeaders);
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders });
}

async function handleM3U(request, db, url) {
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');

  const usersResponse = await db.fetch(new Request('http://fake/get-users'));
  const users = await usersResponse.json();
  const user = users.find(u => u.username === username && u.password === password);

  if (!user || isExpired(user)) {
    return new Response('Acesso negado', { status: 403 });
  }

  const playlist = await getPlaylistFromKV(request);
  let m3u = '#EXTM3U\n';
  
  // Adicionar canais
  playlist.live.forEach(channel => {
    m3u += `#EXTINF:-1 tvg-id="${channel.stream_id}" tvg-name="${channel.name}" tvg-logo="${channel.stream_icon}" group-title="${channel.group}",${channel.name}\n`;
    m3u += `${channel.direct_source}\n`;
  });

  return new Response(m3u, {
    headers: { 'Content-Type': 'application/x-mpegURL' }
  });
}

// ==================== FUNÇÕES UTILITÁRIAS ====================

function jsonResponse(data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

function isExpired(user) {
  if (user.expiresAt === 'never') return false;
  return new Date(user.expiresAt) < new Date();
}

function calculateExpiryDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + parseInt(days));
  return date.toISOString().split('T')[0];
}

function generateId() {
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function generatePassword(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    password += chars.charAt(array[i] % chars.length);
  }
  return password;
}

// Parser de M3U - executado uma vez e armazenado no KV
async function getPlaylistFromKV(request) {
  // Na implementação real, você deve armazenar a playlist parseada no KV
  // Aqui retornamos estrutura vazia ou buscamos do KV
  // Para simplificar, vou retornar uma estrutura básica
  
  // TODO: Implementar busca do KV ou retornar dados parseados
  return {
    live: [],
    vod: [],
    series: {},
    categories: {
      live: [],
      vod: [],
      series: []
    }
  };
}

// ==================== HTML DAS PÁGINAS ====================

function getLoginHTML() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Painel Administrativo - IPTV</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .login-box {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 15px 35px rgba(0,0,0,0.2);
            width: 100%;
            max-width: 400px;
        }
        .login-box h1 {
            color: #1e3c72;
            text-align: center;
            margin-bottom: 30px;
            font-size: 28px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            margin-bottom: 5px;
            color: #555;
            font-weight: 600;
        }
        .form-group input {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 5px;
            font-size: 16px;
            transition: border-color 0.3s;
        }
        .form-group input:focus {
            outline: none;
            border-color: #1e3c72;
        }
        .btn {
            width: 100%;
            padding: 12px;
            background: #1e3c72;
            color: white;
            border: none;
            border-radius: 5px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.3s;
        }
        .btn:hover {
            background: #2a5298;
        }
        .error {
            color: #e74c3c;
            text-align: center;
            margin-top: 15px;
            display: none;
        }
    </style>
</head>
<body>
    <div class="login-box">
        <h1>🔐 Painel IPTV</h1>
        <form id="loginForm">
            <div class="form-group">
                <label>Usuário</label>
                <input type="text" id="username" required placeholder="klord" value="klord">
            </div>
            <div class="form-group">
                <label>Senha</label>
                <input type="password" id="password" required placeholder="Kl0rd777">
            </div>
            <button type="submit" class="btn">Entrar</button>
            <div id="error" class="error">Usuário ou senha incorretos</div>
        </form>
    </div>

    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            
            const res = await fetch('/admin/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            
            const data = await res.json();
            if (data.success) {
                localStorage.setItem('adminToken', data.token);
                window.location.href = '/admin/dashboard';
            } else {
                document.getElementById('error').style.display = 'block';
            }
        });
    </script>
</body>
</html>`;
}

function getDashboardHTML() {
  // HTML do dashboard (simplificado - você pode expandir)
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard - Painel IPTV</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f6fa; }
        .sidebar { position: fixed; left: 0; top: 0; width: 250px; height: 100vh; background: #1e3c72; color: white; padding: 20px; }
        .sidebar h2 { margin-bottom: 30px; text-align: center; border-bottom: 2px solid rgba(255,255,255,0.2); padding-bottom: 20px; }
        .nav-item { padding: 15px; margin: 5px 0; cursor: pointer; border-radius: 5px; transition: background 0.3s; display: flex; align-items: center; gap: 10px; }
        .nav-item:hover, .nav-item.active { background: rgba(255,255,255,0.1); }
        .main-content { margin-left: 250px; padding: 30px; }
        .header { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .stat-card h3 { color: #666; font-size: 14px; margin-bottom: 10px; text-transform: uppercase; }
        .stat-card .number { font-size: 36px; font-weight: bold; color: #1e3c72; }
        .section { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .section h2 { margin-bottom: 20px; color: #1e3c72; display: flex; justify-content: space-between; align-items: center; }
        .btn-primary { background: #1e3c72; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-size: 14px; }
        .btn-primary:hover { background: #2a5298; }
        .btn-danger { background: #e74c3c; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        .btn-success { background: #27ae60; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        .btn-warning { background: #f39c12; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; font-weight: 600; color: #555; }
        tr:hover { background: #f8f9fa; }
        .status-active { color: #27ae60; font-weight: bold; }
        .status-expired { color: #e74c3c; font-weight: bold; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
        .modal-content { background: white; padding: 30px; border-radius: 10px; width: 90%; max-width: 500px; max-height: 90vh; overflow-y: auto; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: 600; color: #555; }
        .form-group input, .form-group select { width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 5px; font-size: 14px; }
        .form-group input:focus, .form-group select:focus { outline: none; border-color: #1e3c72; }
        .form-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
        .hidden { display: none; }
        .search-box { padding: 10px; border: 2px solid #ddd; border-radius: 5px; width: 300px; margin-bottom: 20px; }
        .badge { padding: 4px 8px; border-radius: 3px; font-size: 12px; font-weight: bold; }
        .badge-admin { background: #9b59b6; color: white; }
        .badge-user { background: #3498db; color: white; }
        .copy-link { cursor: pointer; color: #1e3c72; text-decoration: underline; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>📺 IPTV Manager</h2>
        <div class="nav-item active" onclick="showSection('dashboard')"><span>📊</span> Dashboard</div>
        <div class="nav-item" onclick="showSection('users')"><span>👥</span> Usuários</div>
        <div class="nav-item" onclick="showSection('content')"><span>🎬</span> Conteúdo</div>
        <div class="nav-item" onclick="showSection('settings')"><span>⚙️</span> Configurações</div>
        <div class="nav-item" onclick="logout()"><span>🚪</span> Sair</div>
    </div>

    <div class="main-content">
        <div id="dashboard-section">
            <div class="header">
                <h1>Dashboard</h1>
                <div><span id="currentUser"></span> | <span id="currentDate"></span></div>
            </div>
            <div class="stats">
                <div class="stat-card"><h3>Total de Usuários</h3><div class="number" id="totalUsers">0</div></div>
                <div class="stat-card"><h3>Usuários Ativos</h3><div class="number" id="activeUsers">0</div></div>
                <div class="stat-card"><h3>Expirados</h3><div class="number" id="expiredUsers">0</div></div>
                <div class="stat-card"><h3>Canais / Filmes / Séries</h3><div class="number" id="totalContent">0 / 0 / 0</div></div>
            </div>
            <div class="section">
                <h2>📈 Atividade Recente</h2>
                <p>Últimos usuários criados:</p>
                <table id="recentUsers"><thead><tr><th>Usuário</th><th>Criado em</th><th>Expira em</th><th>Status</th></tr></thead><tbody></tbody></table>
            </div>
        </div>

        <div id="users-section" class="hidden">
            <div class="header">
                <h1>Gerenciar Usuários</h1>
                <button class="btn-primary" onclick="openModal('createUser')">+ Novo Usuário</button>
            </div>
            <div class="section">
                <input type="text" class="search-box" id="searchUsers" placeholder="🔍 Buscar usuários..." onkeyup="searchUsers()">
                <table id="usersTable"><thead><tr><th>Usuário</th><th>Senha</th><th>Tipo</th><th>Criado em</th><th>Expira em</th><th>Conexões</th><th>Status</th><th>Ações</th></tr></thead><tbody></tbody></table>
            </div>
        </div>

        <div id="content-section" class="hidden">
            <div class="header"><h1>Conteúdo do Servidor</h1></div>
            <div class="section"><h2>📺 Canais</h2><p id="liveCount">0 categorias</p></div>
            <div class="section"><h2>🎬 Filmes</h2><p id="vodCount">0 categorias</p></div>
            <div class="section"><h2>📺 Séries</h2><p id="seriesCount">0 categorias</p></div>
        </div>

        <div id="settings-section" class="hidden">
            <div class="header"><h1>Configurações</h1></div>
            <div class="section">
                <h2>⚙️ Configurações do Servidor</h2>
                <div class="form-group"><label>Nome do Servidor</label><input type="text" id="serverName"></div>
                <div class="form-group"><label>Dias padrão de expiração</label><input type="number" id="defaultExpiry"></div>
                <div class="form-group"><label>Conexões simultâneas padrão</label><input type="number" id="defaultConnections"></div>
                <button class="btn-primary" onclick="saveSettings()">Salvar Configurações</button>
            </div>
        </div>
    </div>

    <div id="createUserModal" class="modal">
        <div class="modal-content">
            <h2>Criar Novo Usuário</h2>
            <form id="createUserForm">
                <div class="form-group"><label>Usuário (deixe em branco para gerar automático)</label><input type="text" id="newUsername" placeholder="user123"></div>
                <div class="form-group"><label>Senha (deixe em branco para gerar automático)</label><input type="text" id="newPassword" placeholder="senha123"></div>
                <div class="form-group"><label>Dias de validade</label><input type="number" id="newExpiry" value="30" min="1"></div>
                <div class="form-group"><label>Máximo de conexões</label><input type="number" id="newMaxConn" value="1" min="1"></div>
                <div class="form-group"><label>Notas (opcional)</label><input type="text" id="newNotes" placeholder="Cliente XYZ"></div>
                <div class="form-actions">
                    <button type="button" class="btn-primary" onclick="closeModal('createUser')">Cancelar</button>
                    <button type="submit" class="btn-success">Criar Usuário</button>
                </div>
            </form>
        </div>
    </div>

    <div id="editUserModal" class="modal">
        <div class="modal-content">
            <h2>Editar Usuário</h2>
            <form id="editUserForm">
                <input type="hidden" id="editUserId">
                <div class="form-group"><label>Usuário</label><input type="text" id="editUsername" readonly></div>
                <div class="form-group"><label>Nova Senha (deixe em branco para manter)</label><input type="text" id="editPassword" placeholder="Nova senha"></div>
                <div class="form-group"><label>Data de vencimento</label><input type="date" id="editExpiry"></div>
                <div class="form-group"><label>Máximo de conexões</label><input type="number" id="editMaxConn" min="1"></div>
                <div class="form-group"><label>Status</label><select id="editStatus"><option value="Active">Ativo</option><option value="Inactive">Inativo</option><option value="Banned">Banido</option></select></div>
                <div class="form-group"><label>Notas</label><input type="text" id="editNotes"></div>
                <div class="form-actions">
                    <button type="button" class="btn-primary" onclick="closeModal('editUser')">Cancelar</button>
                    <button type="submit" class="btn-success">Salvar Alterações</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        let users = [];
        let currentSection = 'dashboard';

        if (!localStorage.getItem('adminToken')) {
            window.location.href = '/admin';
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadDashboard();
            loadUsers();
            document.getElementById('createUserForm').addEventListener('submit', handleCreateUser);
            document.getElementById('editUserForm').addEventListener('submit', handleEditUser);
        });

        function showSection(section) {
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            event.target.closest('.nav-item').classList.add('active');
            document.getElementById('dashboard-section').classList.add('hidden');
            document.getElementById('users-section').classList.add('hidden');
            document.getElementById('content-section').classList.add('hidden');
            document.getElementById('settings-section').classList.add('hidden');
            document.getElementById(section + '-section').classList.remove('hidden');
            currentSection = section;
        }

        async function loadDashboard() {
            const res = await fetch('/admin/api/stats', { headers: { 'Authorization': localStorage.getItem('adminToken') }});
            if (res.status === 401) { logout(); return; }
            const data = await res.json();
            document.getElementById('totalUsers').textContent = data.totalUsers;
            document.getElementById('activeUsers').textContent = data.activeUsers;
            document.getElementById('expiredUsers').textContent = data.expiredUsers;
            document.getElementById('totalContent').textContent = data.content.live + ' / ' + data.content.vod + ' / ' + data.content.series;
            const tbody = document.querySelector('#recentUsers tbody');
            tbody.innerHTML = data.recentUsers.map(u => '<tr><td>' + u.username + '</td><td>' + new Date(u.createdAt).toLocaleDateString('pt-BR') + '</td><td>' + (u.expiresAt === 'never' ? 'Nunca' : new Date(u.expiresAt).toLocaleDateString('pt-BR')) + '</td><td class="' + (u.status === 'Active' ? 'status-active' : 'status-expired') + '">' + u.status + '</td></tr>').join('');
            document.getElementById('currentDate').textContent = new Date().toLocaleDateString('pt-BR');
            document.getElementById('currentUser').textContent = 'Admin';
        }

        async function loadUsers() {
            const res = await fetch('/admin/api/users', { headers: { 'Authorization': localStorage.getItem('adminToken') }});
            if (res.status === 401) { logout(); return; }
            users = await res.json();
            renderUsers(users);
        }

        function renderUsers(userList) {
            const tbody = document.querySelector('#usersTable tbody');
            tbody.innerHTML = userList.map(u => {
                const isExpired = new Date(u.expiresAt) < new Date() && u.expiresAt !== 'never';
                const statusClass = isExpired ? 'status-expired' : (u.status === 'Active' ? 'status-active' : 'status-expired');
                const statusText = isExpired ? 'EXPIRADO' : u.status;
                return '<tr><td><strong>' + u.username + '</strong></td><td><span class="copy-link" onclick="copyToClipboard(\'' + u.password + '\')" title="Copiar senha">' + u.password.substring(0, 8) + '...</span></td><td><span class="badge ' + (u.isAdmin ? 'badge-admin' : 'badge-user') + '">' + (u.isAdmin ? 'Admin' : 'User') + '</span></td><td>' + new Date(u.createdAt).toLocaleDateString('pt-BR') + '</td><td>' + (u.expiresAt === 'never' ? 'Nunca' : new Date(u.expiresAt).toLocaleDateString('pt-BR')) + '</td><td>' + u.activeConnections + ' / ' + u.maxConnections + '</td><td class="' + statusClass + '">' + statusText + '</td><td><button class="btn-success" onclick="copyLink(\'' + u.username + '\', \'' + u.password + '\')">🔗 Link</button><button class="btn-warning" onclick="editUser(\'' + u.id + '\')">✏️</button><button class="btn-danger" onclick="deleteUser(\'' + u.id + '\')" ' + (u.isAdmin ? 'disabled' : '') + '>🗑️</button></td></tr>';
            }).join('');
        }

        function searchUsers() {
            const term = document.getElementById('searchUsers').value.toLowerCase();
            renderUsers(users.filter(u => u.username.toLowerCase().includes(term) || (u.notes && u.notes.toLowerCase().includes(term))));
        }

        function openModal(modal) { document.getElementById(modal + 'Modal').style.display = 'flex'; }
        function closeModal(modal) { document.getElementById(modal + 'Modal').style.display = 'none'; }

        async function handleCreateUser(e) {
            e.preventDefault();
            const data = {
                username: document.getElementById('newUsername').value,
                password: document.getElementById('newPassword').value,
                expiryDays: parseInt(document.getElementById('newExpiry').value),
                maxConnections: parseInt(document.getElementById('newMaxConn').value),
                notes: document.getElementById('newNotes').value
            };
            const res = await fetch('/admin/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                body: JSON.stringify(data)
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                alert('Usuário criado!\\nUsuário: ' + result.user.username + '\\nSenha: ' + result.user.password);
                closeModal('createUser');
                loadUsers();
                loadDashboard();
                document.getElementById('createUserForm').reset();
            } else {
                alert('Erro: ' + result.error);
            }
        }

        async function editUser(id) {
            const user = users.find(u => u.id === id);
            if (!user) return;
            document.getElementById('editUserId').value = user.id;
            document.getElementById('editUsername').value = user.username;
            document.getElementById('editPassword').value = '';
            document.getElementById('editExpiry').value = user.expiresAt === 'never' ? '' : user.expiresAt;
            document.getElementById('editMaxConn').value = user.maxConnections;
            document.getElementById('editStatus').value = user.status;
            document.getElementById('editNotes').value = user.notes || '';
            openModal('editUser');
        }

        async function handleEditUser(e) {
            e.preventDefault();
            const id = document.getElementById('editUserId').value;
            const data = {
                password: document.getElementById('editPassword').value,
                expiresAt: document.getElementById('editExpiry').value || 'never',
                maxConnections: parseInt(document.getElementById('editMaxConn').value),
                status: document.getElementById('editStatus').value,
                notes: document.getElementById('editNotes').value
            };
            const res = await fetch('/admin/api/users/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                body: JSON.stringify(data)
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                closeModal('editUser');
                loadUsers();
                loadDashboard();
            } else {
                alert('Erro: ' + result.error);
            }
        }

        async function deleteUser(id) {
            if (!confirm('Tem certeza que deseja excluir este usuário?')) return;
            const res = await fetch('/admin/api/users/' + id, {
                method: 'DELETE',
                headers: { 'Authorization': localStorage.getItem('adminToken') }
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                loadUsers();
                loadDashboard();
            }
        }

        function copyLink(username, password) {
            const url = window.location.origin + '/get.php?username=' + username + '&password=' + password + '&type=m3u_plus';
            copyToClipboard(url);
            alert('Link M3U copiado para a área de transferência!');
        }

        function copyToClipboard(text) { navigator.clipboard.writeText(text); }

        async function saveSettings() {
            const data = {
                serverName: document.getElementById('serverName').value,
                defaultExpiryDays: parseInt(document.getElementById('defaultExpiry').value),
                defaultMaxConnections: parseInt(document.getElementById('defaultConnections').value)
            };
            const res = await fetch('/admin/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                body: JSON.stringify(data)
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) alert('Configurações salvas!');
        }

        function logout() {
            localStorage.removeItem('adminToken');
            window.location.href = '/admin';
        }

        window.onclick = function(event) {
            if (event.target.classList.contains('modal')) {
                event.target.style.display = 'none';
            }
        }
    </script>
</body>
</html>`;
}