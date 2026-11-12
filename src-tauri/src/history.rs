// ---------------------------------------------------------------- 延迟历史
//
// 为什么要自己做采样：
//   EasyTier 的 CLI 只提供「当前时刻」的延迟，没有任何历史查询接口。
//   要给用户看「过去 24 小时的趋势」，只能自己定时采样并落盘。
//
// 存储设计：
//   SQLite 单表 samples，主键 (node_id, ts) 天然去重。
//   5 秒采样一次，24 小时 6 个节点约 10 万行、3MB，完全可接受。
//   超过 24 小时的数据每小时清理一次，不需要降采样。
//
// 位置：<程序目录>/data/history.db
//   与 settings.json 同目录，保持绿色便携。

use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 采样间隔：5 秒
///
/// 为什么不是 2 秒（与前端轮询一致）：
///   24h × 6 节点，2 秒要 155 万行（约 6MB），
///   而 5 秒只要 10 万行（约 3MB）。看趋势 5 秒精度完全够。
const SAMPLE_INTERVAL_SEC: u64 = 5;

/// 保留时长：24 小时
const RETENTION_SEC: i64 = 24 * 3600;

/// 清理间隔：1 小时
const CLEANUP_INTERVAL_SEC: u64 = 3600;

pub fn db_path() -> PathBuf {
    crate::root_dir().join("data").join("history.db")
}

/// 采样记录总数（供自检展示，不影响主流程）
///
/// 注意不要先 lock 再调 open_db：open_db 内部自己会抢同一把锁，
/// 造成自死锁（std::sync::Mutex 不可重入）。这里先确保初始化，再单独取锁。
pub fn sample_count() -> Result<i64, String> {
    open_db()?;
    let g = DB.lock().map_err(|_| "数据库锁失败".to_string())?;
    let conn = g.as_ref().ok_or("数据库未初始化")?;
    conn.query_row("SELECT COUNT(*) FROM samples", [], |r| r.get(0))
        .map_err(|e| format!("统计失败: {e}"))
}

fn now_sec() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 全局连接（用一个 Mutex 保护，采样线程与查询命令共用）
static DB: Mutex<Option<Connection>> = Mutex::new(None);

/// 打开数据库并建表。失败返回 Err 供上层决定是否降级。
pub fn open_db() -> Result<(), String> {
    let dir = crate::root_dir().join("data");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 data 目录失败: {e}"))?;

    let conn = Connection::open(db_path()).map_err(|e| format!("打开数据库失败: {e}"))?;

    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS samples (
           node_id TEXT    NOT NULL,
           ts      INTEGER NOT NULL,
           lat     REAL,
           loss    REAL,
           PRIMARY KEY (node_id, ts)
         );
         CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);",
    )
    .map_err(|e| format!("建表失败: {e}"))?;

    let mut guard = DB.lock().map_err(|_| "数据库锁失败".to_string())?;
    *guard = Some(conn);
    Ok(())
}

/// 写入一条采样
pub fn insert_sample(node_id: &str, lat: Option<f64>, loss: Option<f64>) -> Result<(), String> {
    let mut guard = DB.lock().map_err(|_| "数据库锁失败".to_string())?;
    let conn = match guard.as_mut() {
        Some(c) => c,
        None => return Err("数据库未打开".into()),
    };
    conn.execute(
        "INSERT OR REPLACE INTO samples (node_id, ts, lat, loss) VALUES (?1, ?2, ?3, ?4)",
        params![node_id, now_sec(), lat, loss],
    )
    .map_err(|e| format!("写入采样失败: {e}"))?;
    Ok(())
}

/// 清理超过保留期的数据
pub fn cleanup_old() -> Result<usize, String> {
    let mut guard = DB.lock().map_err(|_| "数据库锁失败".to_string())?;
    let conn = match guard.as_mut() {
        Some(c) => c,
        None => return Err("数据库未打开".into()),
    };
    let cutoff = now_sec() - RETENTION_SEC;
    let n = conn
        .execute("DELETE FROM samples WHERE ts < ?1", params![cutoff])
        .map_err(|e| format!("清理失败: {e}"))?;
    Ok(n)
}

/// 一个采样点
#[derive(serde::Serialize, Clone)]
pub struct SamplePoint {
    pub ts: i64,
    pub lat: Option<f64>,
    pub loss: Option<f64>,
}

/// 查询某节点的历史，降采样到最多 `max_points` 个点
///
/// 降采样策略：先按「分钟」聚合取平均（减少数量级），
/// 若仍超过上限，再按固定步长抽稀。这样 24h 数据能压到几百个点，
/// 图表渲染无压力，同时保留趋势形状。
pub fn query_history(node_id: &str, minutes: u32, max_points: usize) -> Result<Vec<SamplePoint>, String> {
    let guard = DB.lock().map_err(|_| "数据库锁失败".to_string())?;
    let conn = match guard.as_ref() {
        Some(c) => c,
        None => return Err("数据库未打开".into()),
    };

    let since = now_sec() - (minutes as i64) * 60;

    // 先取原始数据（按时间升序）
    let mut stmt = conn
        .prepare(
            "SELECT ts, lat, loss FROM samples
             WHERE node_id = ?1 AND ts >= ?2
             ORDER BY ts ASC",
        )
        .map_err(|e| format!("准备查询失败: {e}"))?;

    let rows = stmt
        .query_map(params![node_id, since], |row| {
            Ok(SamplePoint {
                ts: row.get(0)?,
                lat: row.get(1)?,
                loss: row.get(2)?,
            })
        })
        .map_err(|e| format!("查询失败: {e}"))?;

    let mut raw: Vec<SamplePoint> = Vec::new();
    for r in rows {
        if let Ok(p) = r {
            raw.push(p);
        }
    }

    if raw.len() <= max_points {
        return Ok(raw);
    }

    // 按分钟聚合（同一分钟内取平均）
    let mut buckets: Vec<SamplePoint> = Vec::new();
    let mut cur_minute: i64 = -1;
    let mut acc_lat = 0.0;
    let mut cnt_lat = 0usize;
    let mut acc_loss = 0.0;
    let mut cnt_loss = 0usize;
    let mut bucket_ts: i64 = 0;

    let flush = |buckets: &mut Vec<SamplePoint>,
                 ts: i64,
                 acc_lat: &mut f64,
                 cnt_lat: &mut usize,
                 acc_loss: &mut f64,
                 cnt_loss: &mut usize| {
        if *cnt_lat > 0 || *cnt_loss > 0 {
            buckets.push(SamplePoint {
                ts,
                lat: if *cnt_lat > 0 { Some(*acc_lat / *cnt_lat as f64) } else { None },
                loss: if *cnt_loss > 0 { Some(*acc_loss / *cnt_loss as f64) } else { None },
            });
        }
        *acc_lat = 0.0;
        *cnt_lat = 0;
        *acc_loss = 0.0;
        *cnt_loss = 0;
    };

    for p in raw {
        let m = p.ts / 60;
        if cur_minute >= 0 && m != cur_minute {
            flush(&mut buckets, bucket_ts, &mut acc_lat, &mut cnt_lat, &mut acc_loss, &mut cnt_loss);
        }
        cur_minute = m;
        bucket_ts = p.ts;
        if let Some(v) = p.lat {
            acc_lat += v;
            cnt_lat += 1;
        }
        if let Some(v) = p.loss {
            acc_loss += v;
            cnt_loss += 1;
        }
    }
    flush(&mut buckets, bucket_ts, &mut acc_lat, &mut cnt_lat, &mut acc_loss, &mut cnt_loss);

    // 还太多就按步长抽稀
    if buckets.len() <= max_points {
        return Ok(buckets);
    }

    let step = (buckets.len() as f64 / max_points as f64).ceil() as usize;
    let out: Vec<SamplePoint> = buckets
        .into_iter()
        .enumerate()
        .filter(|(i, _)| i % step.max(1) == 0)
        .map(|(_, p)| p)
        .collect();
    Ok(out)
}

/// 某节点的统计（近 N 分钟）
pub fn stats(node_id: &str, minutes: u32) -> Result<(Option<f64>, Option<f64>, Option<f64>), String> {
    let guard = DB.lock().map_err(|_| "数据库锁失败".to_string())?;
    let conn = match guard.as_ref() {
        Some(c) => c,
        None => return Err("数据库未打开".into()),
    };
    let since = now_sec() - (minutes as i64) * 60;
    let r = conn.query_row(
        "SELECT MIN(lat), AVG(lat), MAX(lat) FROM samples
         WHERE node_id = ?1 AND ts >= ?2 AND lat IS NOT NULL",
        params![node_id, since],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    );
    r.map_err(|e| format!("统计失败: {e}"))
}

// ---------------------------------------------------------------- 采样线程

/// 启动后台采样线程（幂等：重复调用只会启动一次）
pub fn start_sampler() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(|| {
        // 等程序完全起来再开始，避免与启动流程抢 CLI
        std::thread::sleep(Duration::from_secs(3));

        if let Err(e) = open_db() {
            eprintln!("[history] 数据库初始化失败，历史功能不可用: {e}");
            return;
        }

        let mut last_cleanup = SystemTime::now();

        loop {
            if crate::core_running() {
                // 只采集非本机节点（本机没有延迟概念）
                if let Ok(v) = crate::cli_json(&["peer"]) {
                    if let Some(arr) = v.as_array() {
                        for p in arr {
                            let kind = p.get("cost").and_then(|x| x.as_str()).unwrap_or("");
                            if kind == "Local" {
                                continue;
                            }
                            let host = p
                                .get("hostname")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string();
                            if host.is_empty() {
                                continue;
                            }
                            let lat = p
                                .get("lat_ms")
                                .and_then(|x| x.as_str())
                                .and_then(|s| s.parse::<f64>().ok());
                            let loss = p
                                .get("loss_rate")
                                .and_then(|x| x.as_str())
                                .map(|s| s.trim_end_matches('%'))
                                .and_then(|s| s.parse::<f64>().ok());

                            if lat.is_some() || loss.is_some() {
                                let _ = insert_sample(&host, lat, loss);
                            }
                        }
                    }
                }
            }

            // 定期清理
            if let Ok(el) = last_cleanup.elapsed() {
                if el.as_secs() >= CLEANUP_INTERVAL_SEC {
                    let _ = cleanup_old();
                    last_cleanup = SystemTime::now();
                }
            }

            std::thread::sleep(Duration::from_secs(SAMPLE_INTERVAL_SEC));
        }
    });
}
