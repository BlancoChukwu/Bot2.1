use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::panic::{catch_unwind, AssertUnwindSafe};

#[napi(object)]
pub struct RouteInput {
  pub debt_raw: String,
  pub revenue_raw: String,
}

fn quick_margin_bps_inner(input: RouteInput) -> i64 {
  let debt = input.debt_raw.parse::<i128>().unwrap_or(0);
  let revenue = input.revenue_raw.parse::<i128>().unwrap_or(0);
  if debt <= 0 {
    return 0;
  }
  (((revenue - debt) * 10_000) / debt) as i64
}

#[napi]
pub fn quick_margin_bps(input: RouteInput) -> Result<i64> {
  let result = catch_unwind(AssertUnwindSafe(|| quick_margin_bps_inner(input)));
  match result {
    Ok(value) => Ok(value),
    Err(_) => Err(Error::from_reason("rust_hotpath_panic")),
  }
}
