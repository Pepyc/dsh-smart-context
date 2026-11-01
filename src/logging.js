const ERROR_CODES = new Set(["ABORT_ERR", "ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC", "EBUSY", "EINVAL", "EMFILE", "ENFILE"]);

/** 日志只输出受控错误码；上游 message、stack、路径和认证值不进入日志。
 * @param {unknown} error */
export function safeErrorCode(error) {
  if (error !== null && typeof error === "object") {
    const value = /** @type {{ code?: unknown, name?: unknown }} */ (error);
    if (typeof value.code === "string" && ERROR_CODES.has(value.code)) return value.code;
    if (value.name === "SourceUnavailableError") return "SOURCE_UNAVAILABLE";
  }
  return "UNEXPECTED_ERROR";
}
