use anyhow::{bail, Result};
use chrono::NaiveDate;
use std::time::Duration;

const RANKINGS: &[&str] = &[
    "best-100",
    "top-installs",
    "trending-7d",
    "social-buzz",
    "most-active",
    "official-100",
    "official-vendors",
    "top-repos",
    "rising-stars",
];

fn is_date(value: &str) -> bool {
    value.len() == 10
        && NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == value)
}

fn ranking_url(ranking: &str, date: &str) -> Result<String> {
    if !RANKINGS.contains(&ranking) || (date != "latest" && !is_date(date)) {
        bail!("Invalid ranking or data date");
    }
    Ok(format!(
        "https://raw.githubusercontent.com/LinklyAI/best-skills/main/data/{date}/rankings/{ranking}.csv"
    ))
}

async fn fetch(url: &str) -> Result<Option<String>> {
    let mut response = crate::proxy::http_client::get()
        .get(url)
        .header(reqwest::header::USER_AGENT, "MSkills")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    response = response.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            bail!("Ranking response is too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(String::from_utf8(bytes)?))
}

pub async fn ranking(ranking: &str, date: &str) -> Result<Option<String>> {
    fetch(&ranking_url(ranking, date)?).await
}

/// 历史快照是从首日起每天一个目录、没有缺口（2026-10-16 核对 61 天），所以本地推算日期，
/// 不再请求 GitHub contents API——匿名 60 次/小时的限额经常被同出口 IP 用完。
/// 今天的快照可能还没生成，只列到昨天（UTC）；「最新」已覆盖今天。
/// shortcut: 上游哪天漏跑会多出一个空日期（前端显示「该日期暂无此榜单」），真出现缺口再换成读目录。
pub fn dates(today: NaiveDate) -> Vec<String> {
    let first = NaiveDate::from_ymd_opt(2026, 8, 16).expect("valid first snapshot date");
    let mut dates: Vec<_> = first
        .iter_days()
        .take_while(|day| *day < today)
        .map(|day| day.format("%Y-%m-%d").to_string())
        .collect();
    dates.reverse();
    dates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_rankings_and_valid_snapshot_dates_are_requested() {
        for board in RANKINGS {
            assert!(ranking_url(board, "latest").is_ok());
            assert!(ranking_url(board, "2026-10-14").is_ok());
        }
        for date in ["../raw", "2026-02-30", "2026-1-01", "2026-10-14/../latest"] {
            assert!(ranking_url("best-100", date).is_err());
        }
        assert!(ranking_url("../raw/buzz", "latest").is_err());
    }

    #[test]
    fn dates_run_newest_first_from_the_first_snapshot_to_yesterday() {
        let day = |d| NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap();
        assert_eq!(dates(day("2026-08-18")), ["2026-08-17", "2026-08-16"]);
        assert!(dates(day("2026-08-16")).is_empty());
        let all = dates(day("2026-10-16"));
        assert_eq!((all.len(), all[0].as_str()), (61, "2026-10-15"));
        assert!(all.iter().all(|d| ranking_url("best-100", d).is_ok()));
    }
}
