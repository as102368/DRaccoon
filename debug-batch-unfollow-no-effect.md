# Debug Session: batch-unfollow-no-effect
- **Status**: [OPEN]
- **Issue**: 批量取关任务显示成功，但抖音关注列表中目标用户仍处于关注状态
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-batch-unfollow-no-effect.ndjson

## Reproduction Steps
1. 打开应用，进入关注列表页
2. 选择若干已关注用户，点击"批量取关"
3. 等待任务完成，显示成功
4. 在抖音网页/APP 中检查目标用户，发现仍处于关注状态

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 取关 POST 请求体为空，抖音未识别到目标用户 | High | Low | Pending |
| B | 服务端返回空响应/反爬响应，被误判为成功 | High | Low | Pending |
| C | Cookie/CSRF Token 失效或缺失，接口未真正执行 | Med | Low | Pending |
| D | 请求签名(X-Bogus/a_bogus)对 POST 状态变更接口不合法 | Med | Med | Pending |
| E | 前端在本地缓存中提前标记为已取关，实际未调用成功 | Low | Low | Pending |

## Log Evidence
[Pending user reproduction]
- Debug server started at http://127.0.0.1:7777/event
- Instrumentation added to:
  - `core/api_client.py::follow_user` / `unfollow_user` (request params/headers/body + response)
  - `core/relation_service.py::_execute_single` (parsed result)
- Test logs cleared, ready for real reproduction

## Related Findings (Sync Count Staleness)
While waiting for reproduction, identified a separate but related issue: the following sync only added/updated records and never deleted accounts unfollowed outside the app. This caused the local count (e.g. 541) to exceed the actual current following count (e.g. 321). Fixed in:
- `storage/database.py`: added `aweme_count` column, `delete_following_not_in()`
- `sync_service.py`: track seen sec_uids and purge stale records after a full sync

## Verification Conclusion
[Pending]
