// telemetry.js -- adapted for Tailwind monitor.html
const API_STATS_URL = '/api/stats';
const REFRESH_MS = 1000;

async function updateStats() {
    const pulseDot = document.getElementById('pulse-dot');
    const clockElement = document.getElementById('live-clock');
    const statusText = document.getElementById('status-text');

    try {
        const res = await fetch(API_STATS_URL);
        if (!res.ok) throw new Error('Server Error');
        const data = await res.json();


        // Online UI
        statusText.innerText = 'Telemetry: Active';
        statusText.classList.remove('text-red-400');
        statusText.classList.add('text-slate-300');
        pulseDot.classList.add('active');
        if (data.server_time) clockElement.innerText = data.server_time;

        // GPU
        if (!data.nvidia || data.nvidia.error) {
            document.getElementById('gpu-util').innerText = data.nvidia?.error || 'N/A';
        } else {
            document.getElementById('gpu-util').innerText = data.nvidia.util || '—';
            document.getElementById('gpu-temp').innerText = data.nvidia.temp || '—';
            document.getElementById('gpu-mem').innerText = data.nvidia.mem || '—';
            document.getElementById('gpu-power').innerText = data.nvidia.power || '—';
            document.getElementById('gpu-fan').innerText = data.nvidia.fan || '—';
        }

        // System
        document.getElementById('sys-load').innerText = data.sys?.load || '—';
        document.getElementById('sys-mem').innerText = `${data.sys?.mem_used || '—'} / ${data.sys?.mem_total || '—'}`;

        // Temps and warnings
        let anyDanger = false;
        if (data.temps) {


            const cpu = Number((data.temps.cpu_temp || '0').replace(/[^\d.]/g, ''));
            const cpuEl = document.getElementById('cpu-temp');
            cpuEl.innerText = (isNaN(cpu) ? 'N/A' : `${cpu}°C`);
            const cpuBadge = document.getElementById('cpuTemp-badge');
            if (cpu > 80) { cpuEl.classList.add('text-red-400'); cpuBadge.innerText = 'High'; anyDanger = true; } else { cpuEl.classList.remove('text-red-400'); cpuBadge.innerText = ''; }

            const ssd = Number((data.temps.ssd_temp || '0').replace(/[^\d.]/g, ''));
            const ssdEl = document.getElementById('ssd-temp'); ssdEl.innerText = isNaN(ssd) ? 'N/A' : `${ssd}°C`;
            if (ssd > 70) { ssdEl.classList.add('text-red-400'); anyDanger = true } else { ssdEl.classList.remove('text-red-400') }

            const vrm = Number((data.temps.vrm_temp || '0').replace(/[^\d.]/g, ''));
            const vrmEl = document.getElementById('vrm-temp'); vrmEl.innerText = isNaN(vrm) ? 'N/A' : `${vrm}°C`;
            if (vrm > 90) { vrmEl.classList.add('text-red-400'); anyDanger = true } else { vrmEl.classList.remove('text-red-400') }

            const pump = parseInt((data.temps.pump_speed || '0').replace(/[^\d]/g, '')) || 0;
            const pumpEl = document.getElementById('pump-speed'); pumpEl.innerText = data.temps.pump_speed || '—';
            if (pump && pump < 500) { pumpEl.classList.add('text-red-400'); anyDanger = true } else { pumpEl.classList.remove('text-red-400') }

            const fanVal = parseInt((data.temps.sys_fan_1 || '0').replace(/[^\d]/g, '')) || 0;
            const fanEl = document.getElementById('sys-fan-1'); const fanBadge = document.getElementById('fan-badge');
            if (fanVal === 0) { fanBadge.innerText = 'Idle'; fanBadge.className = 'text-xs px-2 py-1 rounded-md bg-slate-700 text-slate-300'; fanEl.innerText = ''; }
            else { fanBadge.innerText = 'Active'; fanBadge.className = 'text-xs px-2 py-1 rounded-md bg-slate-700 text-green-300'; fanEl.innerText = `${fanVal} RPM`; }

            // highlight card if danger
            const cards = document.querySelectorAll('section');
            cards.forEach(card => { if (anyDanger) card.classList.add('ring-2', 'ring-red-600/30'); else card.classList.remove('ring-2', 'ring-red-600/30'); });
        }

        // Disk
        if (data.disk) {
            document.getElementById('disk-used').innerText = data.disk.used || '—';
            document.getElementById('disk-percent').innerText = data.disk.percent || '—';
            document.getElementById('disk-avail').innerText = `${data.disk.avail || '—'} of ${data.disk.size || '—'}`;
        }

        // Ollama table
        const body = document.getElementById('ollama-body');
        if (data.ollama && data.ollama.length > 0) {
            body.innerHTML = '';
            data.ollama.forEach(m => {
                const tr = document.createElement('tr');
                tr.className = 'align-top';
                tr.innerHTML = `<td class="py-2"><div class="font-medium">${m.name}</div></td><td class="py-2">${m.size || ''}</td><td class="py-2"><span class="px-2 py-1 rounded text-xs" style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.03)">${m.processor}</span></td><td class="py-2">${m.until || ''}</td>`;
                body.appendChild(tr);
            });
        } else {
            body.innerHTML = '<tr><td colspan="4" class="py-4 text-slate-400 italic">No models currently loaded</td></tr>';
        }

    } catch (err) {
        console.error('updateStats error', err);
        pulseDot.classList.remove('active');
        statusText.innerText = 'Telemetry: Unavailable';
        statusText.className = 'text-red-400';
        clockElement.innerText = 'OFFLINE';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // dropdown
    // const btn = document.getElementById('dropbtn');
    // const dd = document.getElementById('dropdown');
    // btn.addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('hidden'); });
    // document.addEventListener('click', () => dd.classList.add('hidden'));

    updateStats();
    setInterval(updateStats, REFRESH_MS);
});
