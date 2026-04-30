/**
 * Figma to Slack - 로컬 중계 서버
 * 실행: node server.js
 */
const http = require('http');
const https = require('https');

const PORT = 18790;
const SLACK_TOKEN   = 'xoxb-5628266469093-10407206670496-ftzC5GST9xhB2cgqTpGp7ZpD';
const SLACK_CHANNEL = 'C0A8WKD7X19'; // 1_사업팀_디자인요청
const NOTION_TOKEN  = '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';
const NOTION_DB_ID  = '2ed89e87-fdef-8045-8317-ce980386dd9e';
const FIGMA_TOKEN   = 'figd_nAO0k9FlvsAgQrXTO4VJQVjRB0UdroSwsA2DF0cO';

// ── 피그마 API 헬퍼 ──────────────────────────────────────────────

function figmaRequest(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.figma.com',
      path: `/v1/${path}`,
      method: 'GET',
      headers: { 'X-Figma-Token': FIGMA_TOKEN }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 노션 API 헬퍼 ────────────────────────────────────────────────

function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path: `/v1/${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 슬랙 채널에서 노션 페이지 ID가 포함된 스레드 ts 검색
async function findSlackThread(notionPageId) {
  const searchId = notionPageId.replace(/-/g, '');
  let cursor;
  for (let i = 0; i < 15; i++) {
    const params = new URLSearchParams({ channel: SLACK_CHANNEL, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const data = await slackPost('conversations.history?' + params.toString(), null);
    if (!data.ok) break;
    for (const msg of (data.messages || [])) {
      if (msg.text?.includes(searchId)) return msg.ts;
    }
    if (!data.has_more || !data.response_metadata?.next_cursor) break;
    cursor = data.response_metadata.next_cursor;
  }
  return null;
}

// ── 슬랙 API 헬퍼 ────────────────────────────────────────────────

function slackPost(path, body) {
  return new Promise((resolve, reject) => {
    const isGet = !body;
    const data = isGet ? null : new URLSearchParams(body).toString();
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${path}`,
      method: isGet ? 'GET' : 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_TOKEN}`,
        ...(isGet ? {} : {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        })
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function slackUpload(uploadUrl, imageBuffer) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': imageBuffer.length
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(imageBuffer);
    req.end();
  });
}

async function uploadSingleFile(imageBuffer, filename) {
  const safeFilename = filename.replace(/[^\x00-\x7F]/g, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'figma-export.png';
  
  // Step 1: 업로드 URL 발급
  const urlData = await slackPost('files.getUploadURLExternal', {
    filename: safeFilename,
    length: imageBuffer.length
  });
  if (!urlData.ok) throw new Error(`URL 발급 실패: ${urlData.error}`);
  
  // Step 2: 이미지 업로드
  await slackUpload(urlData.upload_url, imageBuffer);
  
  return { id: urlData.file_id, title: safeFilename };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // ── 노션: 진행 중 항목 조회 ──────────────────────────────────
  if (req.method === 'GET' && req.url === '/notion-entries') {
    notionRequest('POST', `databases/${NOTION_DB_ID}/query`, {
      filter: {
        or: [
          { property: '상태', status: { equals: '디자인 진행중' } },
          { property: '상태', status: { equals: '디자인 요청' } },
        ]
      },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    })
    .then(data => {
      const entries = (data.results || []).map(e => ({
        id: e.id,
        title: e.properties['업무 요청 내용']?.title?.[0]?.plain_text || '제목 없음',
        team: e.properties['요청 팀 ']?.multi_select?.[0]?.name || '',
        deadline: e.properties['마감 기한']?.date?.start || '',
        status: e.properties['상태']?.status?.name || '',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries }));
    })
    .catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // ── 노션: 슬랙 스레드 자동 검색 ─────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/find-thread?')) {
    const pageId = new URL('http://x' + req.url).searchParams.get('pageId');
    findSlackThread(pageId)
    .then(ts => {
      let threadUrl = null;
      if (ts) {
        const tsPart = ts.replace('.', '');
        threadUrl = `https://zep-us.slack.com/archives/${SLACK_CHANNEL}/p${tsPart}`;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, threadUrl }));
    })
    .catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // ── 피그마: 섹션에서 실제 프레임 ID 조회 ───────────────────
  if (req.method === 'POST' && req.url === '/figma-node-url') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { fileKey, nodeId } = JSON.parse(body);
        // 해당 노드 정보 조회
        const data = await figmaRequest(`nodes?ids=${encodeURIComponent(nodeId)}&file_key=${fileKey}`);
        const node = data.nodes?.[nodeId]?.document;
        if (!node) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, nodeId }));
          return;
        }
        // 노드 자체가 FRAME이면 그대로 사용
        if (node.type === 'FRAME' || node.type === 'COMPONENT') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, nodeId }));
          return;
        }
        // SECTION이면 안에서 첫 번째 FRAME 찾기
        function findFirstFrame(n) {
          if (n.type === 'FRAME' || n.type === 'COMPONENT') return n.id;
          for (const c of (n.children || [])) {
            const found = findFirstFrame(c);
            if (found) return found;
          }
          return null;
        }
        const frameId = findFirstFrame(node);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, nodeId: frameId || nodeId }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, nodeId, error: err.message }));
      }
    });
    return;
  }

  // ── 노션: 디자인 완료 처리 ───────────────────────────────────
  if (req.method === 'POST' && req.url === '/notion-complete') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { pageId, figmaUrl, fileKey, nodeIds } = JSON.parse(body);

        // 1. 노션 페이지 속성 업데이트
        const pageData = await notionRequest('PATCH', `pages/${pageId}`, {
          properties: {
            '피그마 프레임 링크': { url: figmaUrl },
            '상태': { status: { name: '디자인 완료' } },
            '슬랙 전송 완료': { checkbox: true },
          }
        });
        if (pageData.object !== 'page') throw new Error('노션 페이지 업데이트 실패');

        // 2. 피그마 이미지 URL 조회 후 노션 페이지에 블록 추가
        if (fileKey && nodeIds && nodeIds.length > 0) {
          const ids = nodeIds.map(id => encodeURIComponent(id)).join(',');
          const imgData = await figmaRequest(`images/${fileKey}?ids=${ids}&format=png&scale=2`);

          const children = [];
          for (const nodeId of nodeIds) {
            const imgUrl = imgData.images?.[nodeId];
            if (imgUrl) {
              children.push({
                object: 'block',
                type: 'image',
                image: { type: 'external', external: { url: imgUrl } }
              });
            }
          }
          if (figmaUrl) {
            children.push({
              object: 'block',
              type: 'bookmark',
              bookmark: { url: figmaUrl }
            });
          }
          if (children.length > 0) {
            await notionRequest('PATCH', `blocks/${pageId}/children`, { children });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[노션 완료 처리 오류]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 채널 목록 조회 API
  if (req.method === 'GET' && req.url === '/channels') {
    slackPost('conversations.list', {
      types: 'public_channel,private_channel',
      limit: 200,
      exclude_archived: true
    })
    .then(channelsData => {
      if (!channelsData.ok) {
        throw new Error(channelsData.error);
      }
      
      // 이름순 정렬
      let channels = channelsData.channels
        .filter(ch => !ch.is_archived)
        .map(ch => ({ id: ch.id, name: ch.name }));
      
      // 자주 사용하는 채널 항상 포함 (API에 없어도)
      const favoriteChannels = [
        { id: 'C0A8WKD7X19', name: '1_사업팀_디자인요청' },
        { id: 'C0AM426EXD5', name: '99_소엽' }
      ];
      
      for (const fav of favoriteChannels) {
        if (!channels.find(ch => ch.id === fav.id)) {
          channels.push(fav);
        }
      }
      
      channels.sort((a, b) => a.name.localeCompare(b.name));
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channels }));
    })
    .catch(err => {
      console.error('[채널 조회 오류]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/share') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // 디버깅 로그 (전체 데이터)
        console.log('[디버그] 전체 데이터:', JSON.stringify(data));
        console.log('[디버그] threadUrl:', data.threadUrl);
        
        // 스레드 URL 파싱
        let thread_ts = null;
        if (data.threadUrl) {
          const threadMatch = data.threadUrl.match(/archives\/([A-Z0-9]+)\/p(\d+)/);
          if (threadMatch) {
            const raw = threadMatch[2];
            thread_ts = raw.slice(0, -6) + '.' + raw.slice(-6);
            console.log('[디버그] thread_ts 변환됨:', thread_ts);
          } else {
            console.log('[디버그] threadUrl 형식 불일치:', data.threadUrl);
          }
        } else {
          console.log('[디버그] threadUrl 없음');
        }
        
        // 다중 파일 지원 (frames 배열) 또는 단일 파일 (하위 호환)
        let files = [];
        
        if (data.frames && Array.isArray(data.frames)) {
          // 다중 파일 모드
          console.log(`[공유 요청] 채널: ${data.channelId} / 파일 ${data.frames.length}개`);
          
          for (let i = 0; i < data.frames.length; i++) {
            const frame = data.frames[i];
            const imageBuffer = Buffer.from(frame.imageBase64, 'base64');
            console.log(`  [${i + 1}/${data.frames.length}] 업로드 중: ${frame.filename} (${imageBuffer.length}bytes)`);
            const fileData = await uploadSingleFile(imageBuffer, frame.filename);
            files.push(fileData);
          }
        } else if (data.imageBase64) {
          // 단일 파일 모드 (하위 호환)
          const imageBuffer = Buffer.from(data.imageBase64, 'base64');
          console.log(`[공유 요청] 채널: ${data.channelId} / 파일: ${data.filename} / 크기: ${imageBuffer.length}bytes`);
          const fileData = await uploadSingleFile(imageBuffer, data.filename);
          files.push(fileData);
        } else {
          throw new Error('파일 데이터가 없습니다.');
        }

        // Step 3: 파일 업로드 완료 + 채널 공유
        let comment = '';
        // URL이 있으면 프레임명으로 하이퍼링크, 없으면 프레임명만
        if (data.figmaUrl && data.frameName) {
          comment = `<${data.figmaUrl}|${data.frameName}>`;
        } else if (data.frameName) {
          comment = data.frameName;
        } else if (data.figmaUrl) {
          comment = data.figmaUrl;
        }
        if (data.message) {
          comment += (comment ? '\n' : '') + data.message;
        }
        
        const completePayload = {
          files: JSON.stringify(files),
          channel_id: data.channelId,
          initial_comment: comment
        };
        
        // 스레드가 있으면 추가
        if (thread_ts) {
          completePayload.thread_ts = thread_ts;
        }
        
        const completeData = await slackPost('files.completeUploadExternal', completePayload);
        console.log('[Step 3] 응답:', JSON.stringify(completeData).substring(0, 500));
        
        if (!completeData.ok) {
          // 채널 공유 실패하면 메시지만이라도 보내기
          console.log('[Step 3] 채널 공유 실패, 메시지만 전송...');
          await slackPost('chat.postMessage', {
            channel: data.channelId,
            text: comment + '\n(이미지 업로드됨: ' + files.map(f => f.id).join(', ') + ')'
          });
        }

        console.log(`[완료] ${files.length}개 파일 처리 완료`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[오류]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Figma to Slack 서버 실행 중 (포트 ${PORT})`);
  console.log('피그마 플러그인에서 공유 버튼을 누르면 자동으로 슬랙에 전송됩니다.');
});
