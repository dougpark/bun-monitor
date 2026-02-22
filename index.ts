// Bun-based server replacement for the original Flask app.
import si from "systeminformation";
import { $ } from "bun";

const STORAGE_TARGET = "nvme0n1p2";
const FAST_INTERVAL = 1000; // ms
const SLOW_INTERVAL = 2000; // ms

type AnyObject = { [k: string]: any };

const cache: AnyObject = {
  fast_data: {},
  slow_data: {},
  last_fast_update: 0,
  last_slow_update: 0,
};

function runCommand(cmd: string[]): string {
  try {
    const result = Bun.spawnSync({ cmd });
    if (result.exitCode !== 0) {
      const err = result.stderr
        ? new TextDecoder().decode(result.stderr)
        : `exit ${result.exitCode}`;
      throw new Error(err);
    }
    return new TextDecoder().decode(result.stdout ?? new Uint8Array());
  } catch (e: any) {
    return `__ERROR__:${e.message}`;
  }
}

function run_nvidia_smi() {
  try {
    const out = runCommand([
      "nvidia-smi",
      "--query-gpu=fan.speed,temperature.gpu,power.draw,memory.used,utilization.gpu",
      "--format=csv,noheader,nounits",
    ]);
    if (out.startsWith("__ERROR__")) return { error: out };
    const parts = out.trim().split(",");
    return {
      fan: parts[0]?.trim() + "%",
      temp: parts[1]?.trim() + "°C",
      power: parts[2]?.trim() + "W",
      mem: parts[3]?.trim() + " MiB",
      util: parts[4]?.trim() + "%",
    };
  } catch (e: any) {
    return { error: String(e) };
  }
}

function run_ollama_ps() {
  try {
    const out = runCommand(["docker", "exec", "ollama", "ollama", "ps"]);
    if (out.startsWith("__ERROR__")) return [];
    const lines = out.trim().split(/\r?\n/);
    if (lines.length <= 1) return [];
    const models: AnyObject[] = [];
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 4) {
        models.push({
          name: parts[0],
          id: parts[1],
          size: parts[2],
          processor: parts[3],
          until: parts[5] ?? "N/A",
        });
      }
    }
    return models;
  } catch (e: any) {
    return [];
  }
}

function run_system_info() {
  try {
    const mem = runCommand(["free", "-h"]);
    const memMatch = mem.match(/Mem:\s+(\S+)\s+(\S+)/);
    const up = runCommand(["uptime"]);
    const loadMatch = up.match(/load average:\s*([\d.]+)/);
    return {
      mem_total: memMatch ? memMatch[1] : "N/A",
      mem_used: memMatch ? memMatch[2] : "N/A",
      load: loadMatch ? loadMatch[1] : "N/A",
    };
  } catch (e: any) {
    return { error: String(e) };
  }
}

function run_disk_usage() {
  try {
    const out = runCommand(["df", "-h"]);
    const lines = out.split(/\r?\n/);
    for (const line of lines) {
      if (line.includes(STORAGE_TARGET)) {
        const parts = line.split(/\s+/);
        return {
          storage: STORAGE_TARGET,
          size: parts[1] ?? "N/A",
          used: parts[2] ?? "N/A",
          avail: parts[3] ?? "N/A",
          percent: parts[4] ?? "N/A",
          mount: parts[5] ?? "N/A",
        };
      }
    }
    return {
      storage: `${STORAGE_TARGET} not found`,
      size: "N/A",
      used: "N/A",
      avail: "N/A",
      percent: "0%",
      mount: "N/A",
    };
  } catch (e: any) {
    return {
      storage: STORAGE_TARGET,
      size: "Error",
      used: "N/A",
      avail: "N/A",
      percent: "0%",
      mount: "N/A",
    };
  }
}


async function xrun_temp_info() {
  try {
    // We use si.get to fetch multiple specific hardware groups at once
    const obs = await si.get({
      cpuTemperature: 'main, cores, chipset',
      // 'baseboard' or 'chassis' sometimes contains fan data depending on the driver
      chassis: 'assetTag' 
    });

    // For Fans and extra sensors, 'si.cpuTemperature()' usually 
    // populates 'main' and 'cores', but additional sensors 
    // are often found in the 'si.graphics()' or 'si.baseboard()' calls.
    
    const cpu = await si.cpuTemperature();
    
    // Note: 'systeminformation' doesn't always have a direct 1:1 'fan' method 
    // because Linux drivers vary so much. If 'sensors' worked for you before, 
    // we can still use it for the fans specifically while using SI for the temps.

    const data = {
      cpu_temp: cpu.main !== -1 ? `${cpu.main}°C` : "N/A",
      ssd_temp: cpu.chipset !== -1 ? `${cpu.chipset}°C` : "N/A",
      vrm_temp: "N/A", // VRM is often a custom label
      pump_speed: "0 RPM",
      sys_fan_1: "0 RPM",
    };

    // Use Bun's native shell execution
    const fanCheck = await $`sensors | grep -i 'fan'`.text();

    if (fanCheck) {
      const matches = fanCheck.match(/\d+/g); 
      if (matches && matches.length > 0) data.sys_fan_1 = `${matches[0]} RPM`;
      if (matches && matches.length > 1) data.pump_speed = `${matches[1]} RPM`;
    }

     // Best-effort using `sensors` output; fall back to N/A when not available
    const out = runCommand(["sensors"]);
    // crude parsing: look for lines with 'CPU' or 'Package id' or 'temp1'
    const lines = out.split(/\r?\n/);
    for (const line of lines) {
      // if (
      //   /CPU Temp|Package id 0|Package id/.test(line) &&
      //   /\+?\d+/i.test(line)
      // ) {
      //   const m = line.match(/\+?(\d+\.?\d*)°C/);
      //   if (m) data.cpu_temp = `${m[1]}°C`;
      // }
      if (/nvme|NVMe|SSD/i.test(line) && /\+?(\d+)/.test(line)) {
        const m = line.match(/\+?(\d+\.?\d*)°C/);
        if (m) data.ssd_temp = `${m[1]}°C`;
      }
      // Look for VRM MOS or VRM, followed by any characters, then the temp
      if (/VRM\s*MOS|VRM/i.test(line)) {
        // This regex looks specifically for the +32.0 or 32 format
        const m = line.match(/[:\s]\+?(\d+\.?\d*)°C/);
        if (m) {
          data.vrm_temp = `${m[1]}°C`;
          console.log(`Matched VRM: ${m[1]}°C`); // Debugging log
        }
      }
      if (/Pump Fan|pump/i.test(line) && /\d+ RPM/.test(line)) {
        const m = line.match(/(\d+) RPM/);
        if (m) data.pump_speed = `${m[1]} RPM`;
      }
      if (/System Fan|sys fan/i.test(line) && /\d+ RPM/.test(line)) {
        const m = line.match(/(\d+) RPM/);
        if (m) data.sys_fan_1 = `${m[1]} RPM`;
      }
    }

    // console.log("Hardware Update:", data);
    return data;

  } catch (e: any) {
    return {
      cpu_temp: "Error",
      error: String(e)
    };
  }
}

//=====
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SystemTempData {
    cpu_temp: string;
    ssd_temp: string;
    vrm_temp: string;
    pump_speed: string;
    sys_fan_1: string;
}

export interface SystemTempError {
    error: string;
}

// This function replicates the behavior of the original Python `run_temp_info` using direct file reads from /sys/class/hwmon
export async function run_temp_info(): Promise<SystemTempData | SystemTempError> {
    const data: SystemTempData = {
        cpu_temp: "N/A",
        ssd_temp: "N/A",
        vrm_temp: "N/A",
        pump_speed: "0 RPM",
        sys_fan_1: "0 RPM"
    };

    try {
        const hwmonPath = "/sys/class/hwmon";
        const dirs = await readdir(hwmonPath);
        
        // Structures to hold our parsed data (mirroring psutil's dictionaries)
        const temps: Record<string, { label: string, current: number }[]> = {};
        const fans: Record<string, { label: string, current: number }[]> = {};

        // Helper to safely read a file and return a trimmed string
        const safeRead = async (path: string): Promise<string | null> => {
            try {
                return (await readFile(path, "utf8")).trim();
            } catch {
                return null; // Some hwmon files throw errors if sensors are offline
            }
        };

        // 1. Gather all data from /sys/class/hwmon/
        for (const dir of dirs) {
            if (!dir.startsWith("hwmon")) continue;
            
            const dirPath = join(hwmonPath, dir);
            const name = await safeRead(join(dirPath, "name"));
            if (!name) continue;

            if (!temps[name]) temps[name] = [];
            if (!fans[name]) fans[name] = [];

            const files = await readdir(dirPath);

            // Parse temperatures (input is in millidegrees Celsius, needs / 1000)
            const tempFiles = files.filter(f => f.startsWith("temp") && f.endsWith("_input"));
            for (const input of tempFiles) {
                const prefix = input.split("_")[0];
                const val = await safeRead(join(dirPath, input));
                if (val !== null) {
                    const current = parseInt(val, 10) / 1000;
                    const label = ((await safeRead(join(dirPath, `${prefix}_label`))) ?? prefix) as string;
                    temps[name].push({ label, current });
                }
            }

            // Parse fans (input is directly in RPM)
            const fanFiles = files.filter(f => f.startsWith("fan") && f.endsWith("_input"));
            for (const input of fanFiles) {
                const prefix = input.split("_")[0];
                const val = await safeRead(join(dirPath, input));
                if (val !== null) {
                    const current = parseInt(val, 10);
                    const label = ((await safeRead(join(dirPath, `${prefix}_label`))) ?? prefix) as string;
                    fans[name].push({ label, current });
                }
            }
        }

        // 2. Map the data to your specific object exactly like the Python script
        if (temps["k10temp"] && temps["k10temp"].length > 0) {
            const entry = temps["k10temp"][0];
            if (entry) {
                data.cpu_temp = `${entry.current}°C`;
            }
        }
        
        if (temps["nvme"] && temps["nvme"].length > 0) {
            const entry = temps["nvme"][0];
            if (entry) {
                data.ssd_temp = `${entry.current}°C`;
            }
        }

        if (temps["nct6687"] && temps["nct6687"].length > 0) {
            for (const entry of temps["nct6687"]) {
                if (entry.label === 'VRM MOS') {
                    data.vrm_temp = `${entry.current}°C`;
                }
            }
        }

        if (fans["nct6687"] && fans["nct6687"].length > 0) {
            for (const entry of fans["nct6687"]) {
                if (entry.label === 'Pump Fan') {
                    data.pump_speed = `${entry.current} RPM`;
                } else if (entry.label === 'System Fan #1') {
                    const rpm = entry.current;
                    data.sys_fan_1 = rpm > 0 ? `${rpm} RPM` : "0 RPM";
                }
            }
        }

        return data;

    } catch (error: any) {
        return { error: error.message || String(error) };
    }
}
//=====

function get_server_time() {
  // Get UTC time
  const now = new Date();

  // Get Chicago time as string
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "America/Chicago",
  };
  return new Intl.DateTimeFormat("en-US", opts).format(now);
}

async function get_combined_stats() {
  const now = Date.now();

  if (now - cache.last_fast_update > FAST_INTERVAL) {
    // 1. Fire all fast updates in parallel
    // We use Promise.all to wait for the async ones (like run_temp_info)
    const [nvidia, sys, temps, server_time] = await Promise.all([
      run_nvidia_smi(),
      run_system_info(),
      run_temp_info(), // This is the async one
      get_server_time(),
    ]);

    cache.fast_data = {
      nvidia,
      sys,
      temps,
      server_time,
    };

    console.log("Updated fast stats:", cache.fast_data);
    cache.last_fast_update = now;
  }

  if (now - cache.last_slow_update > SLOW_INTERVAL) {
    // 2. Handle slow updates (assuming these might also be async now or later)
    const [disk, ollama] = await Promise.all([
      run_disk_usage(),
      run_ollama_ps(),
    ]);

    cache.slow_data = { disk, ollama };
    cache.last_slow_update = now;
  }

  return { ...cache.fast_data, ...cache.slow_data };
}

function get_fresh_stats() {
  return {
    nvidia: run_nvidia_smi(),
    sys: run_system_info(),
    temps: run_temp_info(),
    server_time: get_server_time(),
    disk: run_disk_usage(),
    ollama: run_ollama_ps(),
  };
}

async function serveFile(path: string, contentType = "text/html") {
  try {
    const file = Bun.file(path);
    const text = await file.text();
    return new Response(text, {
      status: 200,
      headers: { "Content-Type": contentType },
    });
  } catch (e: any) {
    return new Response(`Not found: ${path}`, { status: 404 });
  }
}

const PORT = Number(process.env.PORT || "4000");

console.log(`Starting bun-monitor server on http://0.0.0.0:${PORT}`);

export default Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req: Request) {
    const url = new URL(req.url);

    // 1. Define common CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // 2. Handle CORS Preflight (OPTIONS) requests
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 3. Handle API Routes
    if (req.method === "GET" && url.pathname === "/api/stats") {
      // Note: Added 'await' because your hardware functions are now async
      const stats = await get_combined_stats(); 
      return new Response(JSON.stringify(stats), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (req.method === "GET" && url.pathname === "/api/fresh_stats") {
      const stats = await get_fresh_stats();
      return new Response(JSON.stringify(stats), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Serve HTML and Static Files
    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/monitor.html")
    ) {
      return await serveFile("public/monitor.html", "text/html");
    }

    if (req.method === "GET" && url.pathname.startsWith("/static/")) {
      const path = `public${url.pathname.replace("/static", "")}`;
      const ext = path.split(".").pop() ?? "";
      const mime =
        ext === "css"
          ? "text/css"
          : ext === "js"
            ? "application/javascript"
            : "text/plain";
      return await serveFile(path, mime);
    }

    // Serve favicons and manifest from /fav/
    if (req.method === "GET" && url.pathname.startsWith("/fav/")) {
      const path = `public${url.pathname}`;
      const ext = path.split(".").pop() ?? "";
      const mime =
        ext === "png"
          ? "image/png"
          : ext === "ico"
            ? "image/x-icon"
            : ext === "webmanifest"
              ? "application/manifest+json"
              : ext === "svg"
                ? "image/svg+xml"
                : "text/plain";
      return await serveFile(path, mime);
    }

    return new Response("Not found", { status: 404 });
  },
});