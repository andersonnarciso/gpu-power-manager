/**
 * Fixtures captured from the real driver of the reference machine.
 *
 * Every block below is the verbatim output of the corresponding command, so
 * the parsers are tested against what the driver actually produces and not
 * against an idealized version of it.
 *
 * Reference machine:
 *   GPU 0: NVIDIA GeForce RTX 4070 Ti   (12282 MiB, 100/285/285 W)
 *   GPU 1: NVIDIA GeForce RTX 5060 Ti   (16311 MiB, 150/180/180 W)
 *   Driver 595.84, CUDA 13.2
 */

/**
 * `nvidia-smi --query-gpu=index,name,uuid,pci.bus_id,driver_version,
 * vbios_version,memory.total,memory.used,utilization.gpu,utilization.memory,
 * temperature.gpu,power.draw,power.limit,power.default_limit,power.min_limit,
 * power.max_limit,enforced.power.limit,clocks.current.sm,clocks.current.memory,
 * clocks.max.sm,clocks.max.memory,fan.speed,persistence_mode,compute_mode
 * --format=csv,noheader,nounits`
 */
export const REAL_GPU_CSV = `0, NVIDIA GeForce RTX 4070 Ti, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1, 00000000:01:00.0, 595.84, 95.04.3C.C0.1A, 12282, 2491, 12, 4, 48, 8.64, 285.00, 285.00, 100.00, 285.00, 285.00, 495, 405, 3105, 10501, 0, Disabled, Default
1, NVIDIA GeForce RTX 5060 Ti, GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646, 00000000:06:00.0, 595.84, 98.06.4E.00.8D, 16311, 613, 0, 1, 36, 6.87, 180.00, 180.00, 150.00, 180.00, 180.00, 180, 405, 3090, 14001, 0, Disabled, Default`;

/**
 * Same CSV layout as {@link REAL_GPU_CSV}, with the placeholders the driver
 * uses for the fields a given board does not expose (`N/A`, `[N/A]`,
 * `Not Supported` and the empty string).
 */
export const GPU_CSV_WITH_MISSING_VALUES = `0, NVIDIA GeForce RTX 3060 Laptop GPU, GPU-1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d, 00000000:01:00.0, 535.129.03, 94.06.29.00.06, 6144, 0, [N/A], N/A, N/A, Not Supported, 80.00, 80.00, 40.00, 80.00, 80.00, 210, 405, 2100, 8001, [N/A], Enabled, Default`;

/** `nvidia-smi --query-gpu=index,clocks_event_reasons.* --format=csv,noheader,nounits` */
export const REAL_THROTTLE_CSV = `0, Not Active, Not Active, Not Active, Not Active, Not Active, Not Active, Not Active, Not Active
1, Not Active, Not Active, Not Active, Not Active, Not Active, Not Active, Not Active, Not Active`;

/** The same query while the first GPU is power capped. */
export const THROTTLE_CSV_ACTIVE = `0, Not Active, Not Active, Active, Not Active, Not Active, Not Active, Not Active, Not Active
1, Not Active, Not Active, Not Active, Not Active, Not Active, Not Active, Not Active, Not Active`;

/**
 * `nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid
 * --format=csv,noheader,nounits`
 */
export const REAL_COMPUTE_APPS_CSV = `2973, /home/anderson/llama.cpp/build/bin/llama-server, 768, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1
293813, /usr/libexec/gnome-remote-desktop-daemon, 197, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1
296489, /usr/bin/sunshine, 199, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1
306223, /home/anderson/.local/opt/antigravity-agent/antigravity --type=gpu-process --ozone-platform=wayland --render-node-override=/dev/dri/renderD129, 86, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1
326082, /usr/bin/nautilus, 42, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1
403545, /usr/bin/python, 63, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1
294480, /usr/libexec/xdg-desktop-portal-gnome, 5, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1
1657283, /usr/bin/ptyxis, 21, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1
2973, /home/anderson/llama.cpp/build/bin/llama-server, 592, GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646`;

/** `nvidia-smi pmon -c 1` */
export const REAL_PMON_OUTPUT = `# gpu         pid   type     sm    mem    enc    dec    jpg    ofa    command
# Idx           #    C/G      %      %      %      %      %      %    name
    0       2973     C      -      -      -      -      -      -    llama-server
    0     293813   C+G      -      -      -      -      -      -    gnome-remote-de
    0     293856     G      -      -      -      -      -      -    gnome-shell
    0     294426     G      42     20      -      -      -      -    Xwayland
    0     294480   C+G      -      -      -      -      -      -    xdg-desktop-por
    0     296489   C+G      -      -      -      -      -      -    sunshine
    0     298271     G      -      -      -      -      -      -    Codex --change-
    0     306223   C+G      -      -      -      -      -      -    A
    0     326082   C+G      -      -      -      -      -      -    nautilus
    0     330035   C+G      -      -      -      -      -      -    renderD129 --cr
    0     403545   C+G      -      -      -      -      -      -    python
    0    1657283   C+G      -      -      -      -      -      -    ptyxis
    0    2294533     G      -      -      -      -      -      -    telegram-deskto
    1       2973     C      -      -      -      -      -      -    llama-server
    1     293856     G      -      -      -      -      -      -    gnome-shell`;

/** `nvidia-smi -q -d PERFORMANCE` */
export const REAL_PERFORMANCE_OUTPUT = `==============NVSMI LOG==============

Timestamp                                              : Thu Oct 29 16:43:32 2026
Driver Version                                         : 595.84
CUDA Version                                           : 13.2

Attached GPUs                                          : 2
GPU 00000000:01:00.0
    Performance State                                  : P8
    Clocks Event Reasons
        Idle                                           : Active
        Applications Clocks Setting                    : Not Active
        SW Power Cap                                   : Not Active
        HW Slowdown                                    : Not Active
            HW Thermal Slowdown                        : Not Active
            HW Power Brake Slowdown                    : Not Active
        Sync Boost                                     : Not Active
        SW Thermal Slowdown                            : Not Active
        Display Clock Setting                          : Not Active
    Clocks Event Reasons Counters
        SW Power Capping                               : 0 us
        Sync Boost                                     : 0 us
        SW Thermal Slowdown                            : 0 us
        HW Thermal Slowdown                            : 0 us
        HW Power Braking                               : 0 us
    Sparse Operation Mode                              : N/A

GPU 00000000:06:00.0
    Performance State                                  : P8
    Clocks Event Reasons
        Idle                                           : Not Active
        Applications Clocks Setting                    : Not Active
        SW Power Cap                                   : Not Active
        HW Slowdown                                    : Not Active
            HW Thermal Slowdown                        : Not Active
            HW Power Brake Slowdown                    : Not Active
        Sync Boost                                     : Not Active
        SW Thermal Slowdown                            : Not Active
        Display Clock Setting                          : Not Active
    Clocks Event Reasons Counters
        SW Power Capping                               : 227384 us
        Sync Boost                                     : 0 us
        SW Thermal Slowdown                            : 0 us
        HW Thermal Slowdown                            : 0 us
        HW Power Braking                               : 0 us
    Sparse Operation Mode                              : N/A`;

/** The banner of `nvidia-smi`, which is the source of the CUDA version. */
export const REAL_BANNER = `Thu Oct 29 16:54:24 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 595.84                 Driver Version: 595.84         CUDA Version: 13.2     |
+-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |               MIG M. | |
|=========================================+========================+======================|
|   0  NVIDIA GeForce RTX 4070 Ti     Off |   00000000:01:00.0  On |                  N/A |
|  0%   49C    P8              8W /  285W |    2623MiB /  12282MiB |     12%      Default |
|                                         |                  N/A |
+-----------------------------------------+------------------------+----------------------+`;

/** The UUIDs of the reference machine. */
export const GPU_4070_UUID = 'GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
export const GPU_5060_UUID = 'GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646';
