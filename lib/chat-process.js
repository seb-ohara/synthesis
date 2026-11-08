const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

function createChatManager(send) {
  const chats = new Map();
  function start(id, cwd, sessionPath) {
    if (chats.has(id)) return;
    const localPi = path.join(os.homedir(), '.local/bin/pi');
    const executable = fs.existsSync(localPi) ? localPi : 'pi';
    const child = spawn(executable, ['--mode', 'rpc', ...(sessionPath ? ['--session', sessionPath] : ['--session-id', id])], { cwd, env: { ...process.env, PATH: [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':') }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chat = { child, buffer: '', stderr: '' };
    chats.set(id, chat);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      chat.buffer += chunk;
      let end;
      while ((end = chat.buffer.indexOf('\n')) !== -1) {
        const line = chat.buffer.slice(0, end).trim(); chat.buffer = chat.buffer.slice(end + 1);
        try { send(id, JSON.parse(line)); } catch { /* Ignore non-protocol output. */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { chat.stderr = (chat.stderr + data).slice(-4000); });
    child.on('error', error => send(id, { type: 'process_error', error: error.message }));
    child.on('close', code => { if (chats.get(id) === chat) chats.delete(id); send(id, { type: 'process_exit', code, error: chat.stderr }); });
    child.stdin.on('error', () => {});
    for (const type of ['get_messages', 'get_state', 'get_available_models', 'get_available_thinking_levels']) child.stdin.write(JSON.stringify({ type }) + '\n');
  }
  function command(id, message) {
    const chat = chats.get(id);
    if (!chat || !chat.child.stdin.writable) return false;
    chat.child.stdin.write(JSON.stringify(message) + '\n'); return true;
  }
  function stop(id) { const chat = chats.get(id); if (chat) { chats.delete(id); chat.child.kill(); } }
  return { start, command, stop };
}
module.exports = { createChatManager };
