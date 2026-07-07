const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const jobFile = 'python/test_user_works_job.json';
const pythonPath = 'C:\\Users\\EDY\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe';
const scriptPath = 'python/user_works_bridge.py';
const taskId = 'test-spawn-1';

console.log('spawn:', pythonPath, scriptPath, '--job', path.resolve(jobFile), '--task-id', taskId);
const proc = spawn(pythonPath, [path.resolve(scriptPath), '--job', path.resolve(jobFile), '--task-id', taskId], {
  cwd: __dirname,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});

let stdoutBuffer = '';
proc.stdout.on('data', (data) => {
  stdoutBuffer += data.toString('utf-8');
  const lines = stdoutBuffer.split(/\r?\n/);
  stdoutBuffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.event === 'items') {
        console.log('progress items count:', parsed.items?.length, 'total:', parsed.total);
      } else if (parsed.event === 'done') {
        console.log('done total:', parsed.total, 'items length:', parsed.items?.length);
      } else {
        console.log('event:', parsed.event, JSON.stringify(parsed).slice(0, 200));
      }
    } catch (e) {
      console.log('log line:', line.slice(0, 200));
    }
  }
});

proc.stderr.on('data', (data) => {
  console.log('stderr:', data.toString('utf-8').slice(0, 500));
});

proc.on('close', (code) => {
  console.log('close code:', code);
  process.exit(0);
});
