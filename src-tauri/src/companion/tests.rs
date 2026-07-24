use std::cell::Cell;
use std::time::Instant;

use rusqlite::{Connection, Transaction};
use serde_json::json;

use super::models::{
    AppendProjectionUpdate, CommandCapability, CommandEnvelope, CommandState, CompanionGrant,
    CompanionSession, ExchangePairingRequest, ExecutionAuthorization, HostCommandAck,
    HostCommandRefusal, IssuePairingRequest, ProjectionKind, ReconnectCursor, SyncPhase,
    SyncRequest, TargetKind, TargetScope,
};
use super::repository::CompanionRepository;
use super::service::{CompanionCommandHost, CompanionService};

const NOW: i64 = 1_900_000_000;
const NOW_MILLIS: i64 = NOW * 1_000;

struct TestHost {
    version: Cell<i64>,
    executions: Cell<usize>,
    uncertain: bool,
}

impl CompanionCommandHost for TestHost {
    fn reauthorize(
        &self,
        _transaction: &Transaction<'_>,
        _session: &CompanionSession,
        _command: &CommandEnvelope,
    ) -> Result<ExecutionAuthorization, HostCommandRefusal> {
        Ok(ExecutionAuthorization {
            current_version: self.version.get(),
        })
    }

    fn execute(
        &self,
        _transaction: &Transaction<'_>,
        _session: &CompanionSession,
        _command: &CommandEnvelope,
        _authorization: &ExecutionAuthorization,
    ) -> Result<HostCommandAck, HostCommandRefusal> {
        self.executions.set(self.executions.get() + 1);
        if self.uncertain {
            return Err(HostCommandRefusal {
                code: "host_unavailable".to_owned(),
                message: "The host acknowledgement was interrupted.".to_owned(),
                definitive: false,
            });
        }
        self.version.set(self.version.get() + 1);
        Ok(HostCommandAck {
            acknowledgement_id: format!("ack-{}", self.executions.get()),
            resulting_version: self.version.get(),
            acknowledged_at: NOW_MILLIS,
            detail: None,
        })
    }
}

#[test]
fn pairing_is_single_use_and_rotation_rejects_old_generations() {
    let mut connection = test_connection();
    let service = CompanionService;
    let pairing = service
        .issue_pairing(
            &mut connection,
            IssuePairingRequest {
                ttl_seconds: 60,
                now: NOW,
            },
        )
        .unwrap();
    let request = ExchangePairingRequest {
        owner_credential: pairing.owner_credential.clone(),
        device_id: "phone-1".to_owned(),
        device_name: "Operator phone".to_owned(),
        grants: vec![CompanionGrant::ReadTasks, CompanionGrant::StopRun],
        now: NOW + 1,
    };
    let exchange = service.exchange_pairing(&mut connection, request).unwrap();
    CompanionRepository::verify_schema(&connection).unwrap();
    assert_eq!(service.list_sessions(&connection).unwrap().len(), 1);
    let session_with_new_grants = service
        .replace_grants(
            &mut connection,
            &exchange.session.session_id,
            vec![CompanionGrant::ReadTasks],
            NOW + 2,
        )
        .unwrap();
    assert_eq!(
        session_with_new_grants.grants,
        vec![CompanionGrant::ReadTasks]
    );

    let reused = service.exchange_pairing(
        &mut connection,
        ExchangePairingRequest {
            owner_credential: pairing.owner_credential,
            device_id: "phone-2".to_owned(),
            device_name: "Second phone".to_owned(),
            grants: Vec::new(),
            now: NOW + 2,
        },
    );
    let reused_error = match reused {
        Err(error) => error,
        Ok(_) => panic!("A pairing credential was reused."),
    };
    assert!(reused_error.contains("already used"));

    let rotated = service
        .rotate_session(&mut connection, &exchange.session.session_id, NOW + 3)
        .unwrap();
    assert_eq!(rotated.credential.generation, 2);
    assert!(service
        .sync(&mut connection, &exchange.credential, None, NOW + 4,)
        .unwrap_err()
        .contains("late generation"));

    service
        .revoke_session(&mut connection, &rotated.session.session_id, NOW + 5)
        .unwrap();
    assert!(service
        .sync(&mut connection, &rotated.credential, None, NOW + 6,)
        .unwrap_err()
        .contains("revoked"));
}

#[test]
fn reconnect_is_ordered_grant_filtered_and_requires_reconciliation() {
    let mut connection = test_connection();
    let service = CompanionService;
    let session = paired_session(&service, &mut connection, vec![CompanionGrant::ReadTasks]);
    let task = service
        .append_projection_update(
            &mut connection,
            projection("event-task-1", 1, ProjectionKind::Task, "task-1", 1),
        )
        .unwrap();
    service
        .append_projection_update(
            &mut connection,
            projection("event-run-1", 1, ProjectionKind::Run, "run-1", 1),
        )
        .unwrap();

    let snapshot = service
        .sync(&mut connection, &session.credential, None, NOW + 2)
        .unwrap();
    assert_eq!(snapshot.phase, SyncPhase::Reconciling);
    assert!(snapshot.is_snapshot);
    assert_eq!(snapshot.cursor, snapshot.latest_sequence);
    let mut authorized_task = task;
    authorized_task.generation = snapshot.generation;
    assert_eq!(snapshot.updates, vec![authorized_task]);
    assert_eq!(
        service
            .mark_disconnected(ReconnectCursor {
                generation: snapshot.generation,
                sequence: snapshot.cursor,
                snapshot: snapshot.next_snapshot.clone(),
            })
            .phase,
        SyncPhase::Stale
    );

    let live = service
        .confirm_reconciled(
            &mut connection,
            &session.credential,
            ReconnectCursor {
                generation: snapshot.generation,
                sequence: snapshot.cursor,
                snapshot: snapshot.next_snapshot.clone(),
            },
            NOW + 3,
        )
        .unwrap();
    assert_eq!(live.phase, SyncPhase::Live);

    let second = service
        .append_projection_update(
            &mut connection,
            projection("event-task-2", 1, ProjectionKind::Task, "task-1", 2),
        )
        .unwrap();
    assert_eq!(
        service
            .append_projection_update(
                &mut connection,
                projection("event-task-2", 1, ProjectionKind::Task, "task-1", 2),
            )
            .unwrap(),
        second
    );
    let updates = service
        .sync(
            &mut connection,
            &session.credential,
            Some(ReconnectCursor {
                generation: live.generation,
                sequence: live.cursor,
                snapshot: None,
            }),
            NOW + 4,
        )
        .unwrap();
    assert_eq!(updates.phase, SyncPhase::Reconciling);
    let mut authorized_second = second;
    authorized_second.generation = updates.generation;
    assert_eq!(updates.updates, vec![authorized_second]);

    CompanionRepository::advance_projection_generation(&mut connection, 1).unwrap();
    assert!(service
        .append_projection_update(
            &mut connection,
            projection("late-event", 1, ProjectionKind::Task, "task-2", 1),
        )
        .unwrap_err()
        .contains("late runtime generation"));
}

#[test]
fn host_acknowledgement_is_the_only_success_and_replay_does_not_execute_twice() {
    let mut connection = test_connection();
    let service = CompanionService;
    let session = paired_session(
        &service,
        &mut connection,
        vec![CompanionGrant::AcceptOutcome],
    );
    let host = TestHost {
        version: Cell::new(4),
        executions: Cell::new(0),
        uncertain: false,
    };
    let first_command = command(
        &session,
        "command-1",
        "idem-1",
        CommandCapability::AcceptOutcome,
        TargetKind::Task,
        4,
    );
    let succeeded = service
        .execute_command(
            &mut connection,
            &session.credential,
            first_command.clone(),
            NOW_MILLIS,
            &host,
        )
        .unwrap();
    assert_eq!(succeeded.state, CommandState::Succeeded);
    assert_eq!(host.executions.get(), 1);
    let replay = service
        .execute_command(
            &mut connection,
            &session.credential,
            first_command,
            NOW_MILLIS,
            &host,
        )
        .unwrap();
    assert_eq!(replay, succeeded);
    assert_eq!(host.executions.get(), 1);

    let uncertain_host = TestHost {
        version: Cell::new(5),
        executions: Cell::new(0),
        uncertain: true,
    };
    let pending_command = command(
        &session,
        "command-2",
        "idem-2",
        CommandCapability::AcceptOutcome,
        TargetKind::Task,
        5,
    );
    let uncertain = service
        .execute_command(
            &mut connection,
            &session.credential,
            pending_command.clone(),
            NOW_MILLIS,
            &uncertain_host,
        )
        .unwrap_err();
    assert!(uncertain.contains("interrupted"));
    let retry = service
        .execute_command(
            &mut connection,
            &session.credential,
            pending_command,
            NOW_MILLIS,
            &uncertain_host,
        )
        .unwrap_err();
    assert!(retry.contains("interrupted"));
    assert_eq!(uncertain_host.executions.get(), 2);
}

#[test]
fn forbidden_grant_denied_and_stale_version_commands_are_refused_and_audited() {
    let mut connection = test_connection();
    let service = CompanionService;
    let session = paired_session(&service, &mut connection, vec![CompanionGrant::StopRun]);
    let host = TestHost {
        version: Cell::new(7),
        executions: Cell::new(0),
        uncertain: false,
    };
    let forbidden = service
        .execute_command(
            &mut connection,
            &session.credential,
            command(
                &session,
                "command-forbidden",
                "idem-forbidden",
                CommandCapability::OpenTerminal,
                TargetKind::Terminal,
                0,
            ),
            NOW_MILLIS,
            &host,
        )
        .unwrap();
    assert_eq!(forbidden.state, CommandState::Refused);
    assert_eq!(
        forbidden.refusal_code.as_deref(),
        Some("forbidden_capability")
    );

    let denied = service
        .execute_command(
            &mut connection,
            &session.credential,
            command(
                &session,
                "command-denied",
                "idem-denied",
                CommandCapability::AcceptOutcome,
                TargetKind::Task,
                7,
            ),
            NOW_MILLIS,
            &host,
        )
        .unwrap();
    assert_eq!(denied.refusal_code.as_deref(), Some("grant_denied"));

    let stale = service
        .execute_command(
            &mut connection,
            &session.credential,
            command(
                &session,
                "command-stale",
                "idem-stale",
                CommandCapability::StopRun,
                TargetKind::Run,
                6,
            ),
            NOW_MILLIS,
            &host,
        )
        .unwrap();
    assert_eq!(stale.refusal_code.as_deref(), Some("version_conflict"));
    assert_eq!(host.executions.get(), 0);

    let audit =
        CompanionRepository::list_audit(&connection, Some(&session.session.device_id), 20).unwrap();
    assert_eq!(audit.len(), 3);
    assert!(audit.iter().all(|record| record.decision == "refused"));
}

#[test]
fn command_audit_clock_uses_a_five_minute_millisecond_window() {
    let mut connection = test_connection();
    let service = CompanionService;
    let session = paired_session(&service, &mut connection, vec![CompanionGrant::StopRun]);
    let host = TestHost {
        version: Cell::new(1),
        executions: Cell::new(0),
        uncertain: false,
    };
    let error = service
        .execute_command(
            &mut connection,
            &session.credential,
            command(
                &session,
                "stale-clock",
                "stale-clock-idempotency",
                CommandCapability::StopRun,
                TargetKind::Run,
                1,
            ),
            NOW_MILLIS + 300_001,
            &host,
        )
        .unwrap_err();
    assert!(error.contains("outside the accepted window"));
    assert_eq!(host.executions.get(), 0);
}

#[test]
fn device_wide_revoke_is_isolated_from_other_logical_devices() {
    let mut connection = test_connection();
    let service = CompanionService;
    let phone_primary = paired_session_for(
        &service,
        &mut connection,
        "phone-a",
        "Phone A primary",
        vec![CompanionGrant::ReadTasks],
    );
    let phone_secondary = paired_session_for(
        &service,
        &mut connection,
        "phone-a",
        "Phone A secondary",
        vec![CompanionGrant::ReadTasks],
    );
    let tablet = paired_session_for(
        &service,
        &mut connection,
        "tablet-b",
        "Tablet B",
        vec![CompanionGrant::ReadTasks],
    );

    let revoked = service
        .revoke_device(&mut connection, "phone-a", NOW + 1)
        .unwrap();
    assert_eq!(revoked.device_id, "phone-a");
    assert_eq!(revoked.revoked_sessions.len(), 2);
    assert!(revoked
        .revoked_sessions
        .iter()
        .all(|session| session.revoked_at == Some(NOW + 1)));
    for credential in [&phone_primary.credential, &phone_secondary.credential] {
        assert!(service
            .sync(&mut connection, credential, None, NOW + 2)
            .unwrap_err()
            .contains("revoked"));
    }

    let unaffected = service
        .sync(&mut connection, &tablet.credential, None, NOW + 2)
        .unwrap();
    assert_eq!(unaffected.phase, SyncPhase::Reconciling);
}

#[test]
fn replacing_grants_forces_a_fresh_filtered_snapshot() {
    let mut connection = test_connection();
    connection
        .execute_batch(
            "INSERT INTO workspaces(
                id, public_id, display_name, pinned, hidden, project_group_id, updated_at
             ) VALUES (1, 'project-1', 'Project', 0, 0, NULL, 10);
             INSERT INTO tasks(
                workspace_id, task_id, title, task_stage, task_stage_version,
                archived, pinned, unread, updated_at
             ) VALUES (1, 'task-1', 'Task', 'running', 1, 0, 0, 0, 11);
             INSERT INTO runs(
                id, workspace_id, task_id, status, agent_outcome,
                verification_outcome, queued_at, started_at, finished_at, version
             ) VALUES (
                'run-1', 1, 'task-1', 'running', 'none', 'not_run',
                12, 12, NULL, 1
             );",
        )
        .unwrap();
    let service = CompanionService;
    let paired = paired_session(
        &service,
        &mut connection,
        vec![CompanionGrant::ReadTasks, CompanionGrant::ReadRuns],
    );
    let initial = service
        .sync(&mut connection, &paired.credential, None, NOW)
        .unwrap();
    assert!(initial
        .updates
        .iter()
        .any(|update| update.kind == ProjectionKind::Run));

    service
        .replace_grants(
            &mut connection,
            &paired.session.session_id,
            vec![CompanionGrant::ReadTasks],
            NOW + 1,
        )
        .unwrap();
    let filtered = service
        .sync(
            &mut connection,
            &paired.credential,
            Some(ReconnectCursor {
                generation: initial.generation,
                sequence: initial.cursor,
                snapshot: None,
            }),
            NOW + 2,
        )
        .unwrap();
    assert!(filtered.is_snapshot);
    assert!(filtered.generation > initial.generation);
    assert!(filtered
        .updates
        .iter()
        .all(|update| update.kind != ProjectionKind::Run));
}

#[test]
fn automatic_projection_events_do_not_collapse_same_timestamp_changes() {
    let connection = test_connection();
    connection
        .execute_batch(
            "INSERT INTO workspaces(
                id, public_id, display_name, pinned, hidden, project_group_id, updated_at
             ) VALUES
                (1, 'project-1', 'One', 0, 0, NULL, 10),
                (2, 'project-2', 'Two', 0, 0, NULL, 10);",
        )
        .unwrap();
    let (count, distinct_ids): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), COUNT(DISTINCT event_id)
             FROM companion_projection_updates
             WHERE entity_kind = 'project'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((count, distinct_ids), (2, 2));
}

#[test]
fn timeline_snapshot_preserves_every_event_for_the_same_run() {
    let mut connection = test_connection();
    connection
        .execute_batch(
            "INSERT INTO workspaces(
                id, public_id, display_name, pinned, hidden, project_group_id, updated_at
             ) VALUES (1, 'project-1', 'Project', 0, 0, NULL, 10);
             INSERT INTO tasks(
                workspace_id, task_id, title, task_stage, task_stage_version,
                archived, pinned, unread, updated_at
             ) VALUES (1, 'task-1', 'Task', 'running', 1, 0, 0, 0, 11);
             INSERT INTO runs(
                id, workspace_id, task_id, status, agent_outcome,
                verification_outcome, queued_at, started_at, finished_at, version
             ) VALUES (
                'run-1', 1, 'task-1', 'running', 'none', 'not_run',
                12, 12, NULL, 1
             );
             INSERT INTO run_events(
                run_id, sequence, timestamp, event_type, safe_payload_json
             ) VALUES
                ('run-1', 1, 13, 'agent.started', '{\"summary\":\"Started\"}'),
                ('run-1', 2, 14, 'agent.progress', '{\"summary\":\"Progress\"}');",
        )
        .unwrap();
    let service = CompanionService;
    let paired = paired_session(
        &service,
        &mut connection,
        vec![CompanionGrant::ReadSafeTimeline],
    );
    let snapshot = service
        .sync(&mut connection, &paired.credential, None, NOW)
        .unwrap();
    let timeline = snapshot
        .updates
        .iter()
        .filter(|update| update.kind == ProjectionKind::SafeTimeline)
        .collect::<Vec<_>>();
    assert_eq!(timeline.len(), 2);
    assert_ne!(timeline[0].entity_id, timeline[1].entity_id);
}

#[test]
fn derived_project_task_and_observatory_summaries_update_incrementally() {
    let mut connection = test_connection();
    connection
        .execute(
            "INSERT INTO workspaces(
                id, public_id, display_name, pinned, hidden, project_group_id, updated_at
             ) VALUES (1, 'project-1', 'Project', 0, 0, NULL, 10)",
            [],
        )
        .unwrap();
    let service = CompanionService;
    let paired = paired_session(
        &service,
        &mut connection,
        vec![
            CompanionGrant::ReadProjects,
            CompanionGrant::ReadTasks,
            CompanionGrant::ReadRuns,
            CompanionGrant::ReadSafeTimeline,
            CompanionGrant::ReadObservatory,
        ],
    );
    let initial = service
        .sync(&mut connection, &paired.credential, None, NOW)
        .unwrap();

    connection
        .execute_batch(
            "INSERT INTO tasks(
                workspace_id, task_id, title, task_stage, task_stage_version,
                archived, pinned, unread, updated_at
             ) VALUES (1, 'task-1', 'Task', 'running', 1, 0, 0, 0, 11);
             INSERT INTO runs(
                id, workspace_id, task_id, status, agent_outcome,
                verification_outcome, queued_at, started_at, finished_at, version
             ) VALUES (
                'run-1', 1, 'task-1', 'running', 'none', 'not_run',
                12, 12, NULL, 1
             );
             INSERT INTO run_events(
                run_id, sequence, timestamp, event_type, safe_payload_json
             ) VALUES (
                'run-1', 1, 13, 'agent.progress', '{\"summary\":\"Progress\"}'
             );",
        )
        .unwrap();
    let updates = service
        .sync(
            &mut connection,
            &paired.credential,
            Some(ReconnectCursor {
                generation: initial.generation,
                sequence: initial.cursor,
                snapshot: None,
            }),
            NOW,
        )
        .unwrap();

    assert!(updates.updates.iter().any(|update| {
        update.kind == ProjectionKind::Project
            && update
                .payload
                .get("taskCount")
                .and_then(serde_json::Value::as_i64)
                == Some(1)
    }));
    assert!(updates.updates.iter().any(|update| {
        update.kind == ProjectionKind::Task
            && update
                .payload
                .get("currentRunId")
                .and_then(serde_json::Value::as_str)
                == Some("run-1")
    }));
    assert!(updates.updates.iter().any(|update| {
        update.kind == ProjectionKind::Observatory
            && update
                .payload
                .get("safeLatestActivity")
                .and_then(serde_json::Value::as_str)
                == Some("agent.progress")
    }));
}

#[test]
fn notifications_require_attention_grant_use_canonical_links_and_stop_after_revoke() {
    let mut connection = test_connection();
    connection
        .execute_batch(
            "INSERT INTO workspaces(
                id, public_id, display_name, pinned, hidden, project_group_id, updated_at
             ) VALUES (1, 'project-1', 'Private project name', 0, 0, NULL, 10);
             INSERT INTO tasks(
                workspace_id, task_id, title, task_stage, task_stage_version,
                archived, pinned, unread, updated_at
             ) VALUES (1, 'task-1', 'Private task title', 'running', 1, 0, 0, 0, 11);
             INSERT INTO attention_occurrences(
                id, workspace_id, task_id, run_id, kind, priority, title,
                safe_summary, surface, created_at, resolved_at, acknowledged_at,
                notification_delivered_at
             ) VALUES (
                'attention-1', 1, 'task-1', NULL, 'decision', 1,
                'Sensitive internal title', 'Sensitive internal summary',
                'inbox', 12, NULL, NULL, NULL
             );",
        )
        .unwrap();
    let service = CompanionService;
    let allowed = paired_session_for(
        &service,
        &mut connection,
        "attention-phone",
        "Attention phone",
        vec![CompanionGrant::ReadAttention],
    );
    let denied = paired_session_for(
        &service,
        &mut connection,
        "tasks-only-phone",
        "Tasks-only phone",
        vec![CompanionGrant::ReadTasks],
    );

    assert!(service
        .notifications(&mut connection, &denied.credential, None, Some(10), NOW,)
        .unwrap_err()
        .contains("do not authorize"));
    let page = service
        .notifications(&mut connection, &allowed.credential, None, Some(10), NOW)
        .unwrap();
    assert_eq!(page.notifications.len(), 1);
    let notification = &page.notifications[0];
    assert_eq!(notification.attention_id, "attention-1");
    assert_eq!(notification.deep_link, "xiao://attention/attention-1");
    assert_eq!(notification.title, "Operator decision needed");
    assert_eq!(
        notification.body,
        "Open Xiao Companion to review the canonical Attention item."
    );
    assert!(!notification.body.contains("Sensitive"));
    let notification_cursor = page.next_cursor.clone().unwrap();
    let empty_page = service
        .notifications(
            &mut connection,
            &allowed.credential,
            Some(notification_cursor.clone()),
            Some(10),
            NOW,
        )
        .unwrap();
    assert!(empty_page.notifications.is_empty());
    assert_eq!(empty_page.next_cursor, Some(notification_cursor));

    let initial_attention = service
        .sync(&mut connection, &allowed.credential, None, NOW)
        .unwrap();
    connection
        .execute(
            "UPDATE attention_occurrences
             SET resolved_at = ?1 WHERE id = 'attention-1'",
            [NOW_MILLIS],
        )
        .unwrap();
    let resolved_attention = service
        .sync(
            &mut connection,
            &allowed.credential,
            Some(ReconnectCursor {
                generation: initial_attention.generation,
                sequence: initial_attention.cursor,
                snapshot: None,
            }),
            NOW,
        )
        .unwrap();
    assert!(resolved_attention.updates.iter().any(|update| {
        update.kind == ProjectionKind::Attention
            && update.entity_id == "attention-1"
            && update
                .payload
                .get("deleted")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
    }));

    service
        .revoke_device(&mut connection, "attention-phone", NOW + 1)
        .unwrap();
    assert!(service
        .notifications(
            &mut connection,
            &allowed.credential,
            None,
            Some(10),
            NOW + 2,
        )
        .unwrap_err()
        .contains("revoked"));
}

#[test]
fn runtime_outbox_survives_reopen_and_command_replay_stays_duplicate_safe() {
    let database_path = std::env::temp_dir().join(format!(
        "xiao-companion-outbox-{}.sqlite",
        uuid::Uuid::now_v7()
    ));
    let service = CompanionService;
    let (credential, envelope, pending_result) = {
        let mut connection = Connection::open(&database_path).unwrap();
        initialize_test_schema(&mut connection);
        let session = paired_session(&service, &mut connection, vec![CompanionGrant::StopRun]);
        let envelope = command(
            &session,
            "crash-safe-command",
            "crash-safe-idempotency",
            CommandCapability::StopRun,
            TargetKind::Run,
            4,
        );
        let host = TestHost {
            version: Cell::new(4),
            executions: Cell::new(0),
            uncertain: false,
        };
        let pending_result = service
            .execute_command(
                &mut connection,
                &session.credential,
                envelope.clone(),
                NOW_MILLIS,
                &host,
            )
            .unwrap();
        assert_eq!(
            pending_result.state,
            CommandState::PendingHostAcknowledgement
        );
        assert_eq!(host.executions.get(), 0);
        assert_eq!(
            CompanionRepository::pending_runtime_effects(&connection, 10)
                .unwrap()
                .len(),
            1
        );
        (session.credential, envelope, pending_result)
    };

    {
        let mut connection = Connection::open(&database_path).unwrap();
        let pending = CompanionRepository::claim_runtime_effects(&mut connection, 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].command_id, "crash-safe-command");
        assert_eq!(pending[0].envelope, envelope);
        assert_eq!(pending[0].attempt_count, 0);
        drop(connection);
    }

    {
        let mut connection = Connection::open(&database_path).unwrap();
        let recovered = CompanionRepository::claim_runtime_effects(&mut connection, 10).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].command_id, "crash-safe-command");
        assert_eq!(recovered[0].attempt_count, 1);
        CompanionRepository::acknowledge_runtime_dispatch(
            &mut connection,
            "crash-safe-command",
            5,
            NOW_MILLIS + 1,
        )
        .unwrap();
    }

    {
        let mut connection = Connection::open(&database_path).unwrap();
        assert!(
            CompanionRepository::pending_runtime_effects(&connection, 10)
                .unwrap()
                .is_empty()
        );
        let replay_host = TestHost {
            version: Cell::new(4),
            executions: Cell::new(0),
            uncertain: false,
        };
        let replay = service
            .execute_command(
                &mut connection,
                &credential,
                envelope,
                NOW_MILLIS + 1,
                &replay_host,
            )
            .unwrap();
        assert_eq!(
            pending_result.state,
            CommandState::PendingHostAcknowledgement
        );
        assert_eq!(replay.state, CommandState::Succeeded);
        assert_eq!(
            replay
                .acknowledgement
                .as_ref()
                .map(|acknowledgement| acknowledgement.resulting_version),
            Some(5)
        );
        assert_eq!(replay_host.executions.get(), 0);
        let outbox_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM companion_command_outbox", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(outbox_rows, 1);
    }
    std::fs::remove_file(&database_path).unwrap();
}

#[test]
fn runtime_refusal_rolls_back_outbox_cancellation_when_command_update_fails() {
    let mut connection = test_connection();
    let service = CompanionService;
    let session = paired_session(&service, &mut connection, vec![CompanionGrant::StopRun]);
    let host = TestHost {
        version: Cell::new(4),
        executions: Cell::new(0),
        uncertain: false,
    };
    let result = service
        .execute_command(
            &mut connection,
            &session.credential,
            command(
                &session,
                "atomic-refusal-command",
                "atomic-refusal-key",
                CommandCapability::StopRun,
                TargetKind::Run,
                4,
            ),
            NOW_MILLIS,
            &host,
        )
        .unwrap();
    assert_eq!(result.state, CommandState::PendingHostAcknowledgement);

    connection
        .execute_batch(
            "CREATE TRIGGER fail_companion_runtime_refusal
             BEFORE UPDATE OF status ON companion_commands
             WHEN NEW.command_id = 'atomic-refusal-command' AND NEW.status = 'refused'
             BEGIN
                 SELECT RAISE(ABORT, 'injected command refusal failure');
             END;",
        )
        .unwrap();

    let error = CompanionRepository::refuse_runtime_effect(
        &mut connection,
        "atomic-refusal-command",
        "runtime_effect_failed",
        "The runtime effect failed.",
        NOW_MILLIS + 1,
    )
    .unwrap_err();
    assert!(error.contains("injected command refusal failure"));

    let (command_status, outbox_status): (String, String) = connection
        .query_row(
            "SELECT commands.status, outbox.status
             FROM companion_commands AS commands
             JOIN companion_command_outbox AS outbox
               ON outbox.command_id = commands.command_id
             WHERE commands.command_id = ?1",
            ["atomic-refusal-command"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(command_status, "pending");
    assert_eq!(outbox_status, "pending");
    assert_eq!(
        CompanionRepository::pending_runtime_effects(&connection, 10)
            .unwrap()
            .len(),
        1
    );
    let refusal_audit_count: i64 = connection
        .query_row(
            "SELECT COUNT(*)
             FROM companion_audit
             WHERE command_id = ?1 AND decision = 'refused'",
            ["atomic-refusal-command"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(refusal_audit_count, 0);
}

#[test]
fn revocation_cancels_queued_runtime_effects_before_dispatch() {
    let mut connection = test_connection();
    let service = CompanionService;
    let session = paired_session(&service, &mut connection, vec![CompanionGrant::StopRun]);
    let host = TestHost {
        version: Cell::new(4),
        executions: Cell::new(0),
        uncertain: false,
    };
    let result = service
        .execute_command(
            &mut connection,
            &session.credential,
            command(
                &session,
                "revoked-command",
                "revoked-command-key",
                CommandCapability::StopRun,
                TargetKind::Run,
                4,
            ),
            NOW_MILLIS,
            &host,
        )
        .unwrap();
    assert_eq!(result.state, CommandState::PendingHostAcknowledgement);

    service
        .revoke_session(&mut connection, &session.session.session_id, NOW + 1)
        .unwrap();
    assert!(
        CompanionRepository::pending_runtime_effects(&connection, 10)
            .unwrap()
            .is_empty()
    );
    let (command_status, outbox_status): (String, String) = connection
        .query_row(
            "SELECT command.status, outbox.status
             FROM companion_commands command
             JOIN companion_command_outbox outbox ON outbox.command_id = command.command_id
             WHERE command.command_id = 'revoked-command'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (command_status.as_str(), outbox_status.as_str()),
        ("refused", "cancelled")
    );
    assert_eq!(host.executions.get(), 0);
}

#[test]
fn synchronization_stays_bounded_at_documented_scale_without_payload_storage() {
    let mut connection = test_connection();
    seed_documented_scale(&mut connection);
    for (table, expected) in [
        ("workspaces", 100_i64),
        ("tasks", 10_000),
        ("attention_occurrences", 1_000),
        ("run_events", 100_000),
    ] {
        let actual: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(actual, expected, "unexpected {table} scale");
    }
    let journal_columns = connection
        .prepare("PRAGMA table_info(companion_projection_updates)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(!journal_columns
        .iter()
        .any(|column| column == "payload_json"));

    let service = CompanionService;
    let session = paired_session_for(
        &service,
        &mut connection,
        "scale-device",
        "Scale device",
        vec![
            CompanionGrant::ReadProjects,
            CompanionGrant::ReadTasks,
            CompanionGrant::ReadRuns,
            CompanionGrant::ReadAttention,
            CompanionGrant::ReadSafeTimeline,
            CompanionGrant::ReadObservatory,
        ],
    );
    let started = Instant::now();
    let mut page = service
        .sync_page(
            &mut connection,
            &session.credential,
            SyncRequest {
                cursor: None,
                limit: Some(500),
            },
            NOW,
        )
        .unwrap();
    assert!(page.is_snapshot);
    assert!(page.has_more);
    assert_eq!(page.updates.len(), 500);
    assert!(page.next_snapshot.is_some());
    let mut synchronized = page.updates.len();
    while page.has_more {
        page = service
            .sync_page(
                &mut connection,
                &session.credential,
                SyncRequest {
                    cursor: Some(ReconnectCursor {
                        generation: page.generation,
                        sequence: page.cursor,
                        snapshot: page.next_snapshot.clone(),
                    }),
                    limit: Some(500),
                },
                NOW,
            )
            .unwrap();
        synchronized += page.updates.len();
    }
    let elapsed = started.elapsed();
    assert_eq!(page.cursor, page.latest_sequence);
    assert!(
        synchronized <= 22_000,
        "bounded synchronization returned {synchronized} projection rows"
    );
    assert!(
        elapsed < std::time::Duration::from_secs(20),
        "bounded scale synchronization took {elapsed:?}"
    );
}

fn test_connection() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    initialize_test_schema(&mut connection);
    connection
}

fn initialize_test_schema(connection: &mut Connection) {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE rollout_capabilities (
                 capability_id TEXT PRIMARY KEY,
                 version INTEGER NOT NULL,
                 enabled INTEGER NOT NULL,
                 migrated_at INTEGER NOT NULL,
                 enabled_at INTEGER
             );
             CREATE TABLE workspaces (
                 id INTEGER PRIMARY KEY,
                 public_id TEXT,
                 display_name TEXT,
                 pinned INTEGER NOT NULL DEFAULT 0,
                 hidden INTEGER NOT NULL DEFAULT 0,
                 project_group_id TEXT,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE tasks (
                 workspace_id INTEGER NOT NULL,
                 task_id TEXT NOT NULL,
                 title TEXT NOT NULL,
                 task_stage TEXT NOT NULL,
                 task_stage_version INTEGER NOT NULL,
                 archived INTEGER NOT NULL DEFAULT 0,
                 pinned INTEGER NOT NULL DEFAULT 0,
                 unread INTEGER NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY(workspace_id, task_id),
                 FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
             );
             CREATE TABLE runs (
                 id TEXT PRIMARY KEY,
                 workspace_id INTEGER NOT NULL,
                 task_id TEXT NOT NULL,
                 status TEXT NOT NULL,
                 agent_outcome TEXT NOT NULL,
                 verification_outcome TEXT NOT NULL,
                 queued_at INTEGER NOT NULL,
                 started_at INTEGER,
                 finished_at INTEGER,
                 version INTEGER NOT NULL,
                 FOREIGN KEY(workspace_id, task_id)
                     REFERENCES tasks(workspace_id, task_id) ON DELETE CASCADE
             );
             CREATE TABLE run_events (
                 run_id TEXT NOT NULL,
                 sequence INTEGER NOT NULL,
                 timestamp INTEGER NOT NULL,
                 event_type TEXT NOT NULL,
                 safe_payload_json TEXT NOT NULL,
                 PRIMARY KEY(run_id, sequence),
                 FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
             );
             CREATE TABLE attention_occurrences (
                 id TEXT PRIMARY KEY,
                 workspace_id INTEGER NOT NULL,
                 task_id TEXT NOT NULL,
                 run_id TEXT,
                 kind TEXT NOT NULL,
                 priority INTEGER NOT NULL,
                 title TEXT NOT NULL,
                 safe_summary TEXT NOT NULL,
                 surface TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 resolved_at INTEGER,
                 acknowledged_at INTEGER,
                 notification_delivered_at INTEGER,
                 FOREIGN KEY(workspace_id, task_id)
                     REFERENCES tasks(workspace_id, task_id) ON DELETE CASCADE
             );
             CREATE TABLE verification_attempts (
                 id TEXT PRIMARY KEY,
                 run_id TEXT NOT NULL,
                 attempt_number INTEGER NOT NULL,
                 trigger TEXT NOT NULL,
                 status TEXT NOT NULL,
                 started_at INTEGER NOT NULL,
                 finished_at INTEGER,
                 updated_at INTEGER NOT NULL,
                 version INTEGER NOT NULL,
                 FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
             );
             CREATE TABLE pending_inputs (
                 id TEXT PRIMARY KEY,
                 run_id TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 safe_summary_json TEXT NOT NULL,
                 opened_at INTEGER NOT NULL,
                 resolved_at INTEGER,
                 invalidated_at INTEGER,
                 FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
             );",
        )
        .unwrap();
    CompanionRepository::install_schema(connection).unwrap();
}

fn paired_session(
    service: &CompanionService,
    connection: &mut Connection,
    grants: Vec<CompanionGrant>,
) -> super::models::ExchangedSession {
    paired_session_for(service, connection, "test-device", "Test device", grants)
}

fn paired_session_for(
    service: &CompanionService,
    connection: &mut Connection,
    device_id: &str,
    device_name: &str,
    grants: Vec<CompanionGrant>,
) -> super::models::ExchangedSession {
    let pairing = service
        .issue_pairing(
            connection,
            IssuePairingRequest {
                ttl_seconds: 60,
                now: NOW - 2,
            },
        )
        .unwrap();
    service
        .exchange_pairing(
            connection,
            ExchangePairingRequest {
                owner_credential: pairing.owner_credential,
                device_id: device_id.to_owned(),
                device_name: device_name.to_owned(),
                grants,
                now: NOW - 1,
            },
        )
        .unwrap()
}

fn seed_documented_scale(connection: &mut Connection) {
    connection
        .execute_batch(&format!(
            r#"
            BEGIN;
            WITH digits(d) AS (
                VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
            ),
            numbers(n) AS (
                SELECT 1 + a.d + 10 * b.d
                FROM digits a CROSS JOIN digits b
            )
            INSERT INTO workspaces(
                id, public_id, display_name, pinned, hidden, project_group_id, updated_at
            )
            SELECT n, printf('project-%d', n), printf('Project %d', n),
                   0, 0, NULL, {now} + n
            FROM numbers;

            WITH digits(d) AS (
                VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
            ),
            numbers(n) AS (
                SELECT 1 + a.d + 10 * b.d + 100 * c.d + 1000 * d.d
                FROM digits a CROSS JOIN digits b
                CROSS JOIN digits c CROSS JOIN digits d
            )
            INSERT INTO tasks(
                workspace_id, task_id, title, task_stage, task_stage_version,
                archived, pinned, unread, updated_at
            )
            SELECT ((n - 1) / 100) + 1, printf('task-%d', n),
                   printf('Task %d', n), 'backlog', 1, 0, 0, 0, {now} + n
            FROM numbers;

            WITH digits(d) AS (
                VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
            ),
            numbers(n) AS (
                SELECT 1 + a.d + 10 * b.d
                FROM digits a CROSS JOIN digits b
            )
            INSERT INTO runs(
                id, workspace_id, task_id, status, agent_outcome,
                verification_outcome, queued_at, started_at, finished_at, version
            )
            SELECT printf('run-%d', n), n, printf('task-%d', ((n - 1) * 100) + 1),
                   'running', 'none', 'not_run', {now} + n, {now} + n,
                   NULL, 1
            FROM numbers;

            WITH digits(d) AS (
                VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
            ),
            numbers(n) AS (
                SELECT 1 + a.d + 10 * b.d + 100 * c.d
                FROM digits a CROSS JOIN digits b CROSS JOIN digits c
            )
            INSERT INTO attention_occurrences(
                id, workspace_id, task_id, run_id, kind, priority, title,
                safe_summary, surface, created_at, resolved_at, acknowledged_at,
                notification_delivered_at
            )
            SELECT printf('attention-%d', n), ((n - 1) / 100) + 1,
                   printf('task-%d', n), NULL, 'decision', 1,
                   'Operator decision needed', 'Review the canonical item.',
                   'inbox', {now} + n, NULL, NULL, NULL
            FROM numbers;

            WITH digits(d) AS (
                VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
            ),
            numbers(n) AS (
                SELECT 1 + a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 10000 * e.d
                FROM digits a CROSS JOIN digits b CROSS JOIN digits c
                CROSS JOIN digits d CROSS JOIN digits e
            )
            INSERT INTO run_events(
                run_id, sequence, timestamp, event_type, safe_payload_json
            )
            SELECT printf('run-%d', ((n - 1) / 1000) + 1),
                   ((n - 1) % 1000) + 1, {now} + n,
                   'agent.progress', '{{"summary":"Bounded event"}}'
            FROM numbers;
            COMMIT;
            "#,
            now = NOW
        ))
        .unwrap();
}

fn projection(
    event_id: &str,
    generation: i64,
    kind: ProjectionKind,
    entity_id: &str,
    entity_version: i64,
) -> AppendProjectionUpdate {
    let entity_id = match kind {
        ProjectionKind::Task | ProjectionKind::TaskStage => format!("1/{entity_id}"),
        _ => entity_id.to_owned(),
    };
    AppendProjectionUpdate {
        event_id: event_id.to_owned(),
        generation,
        kind,
        entity_id,
        entity_version,
        occurred_at: NOW,
    }
}

fn command(
    session: &super::models::ExchangedSession,
    command_id: &str,
    idempotency_key: &str,
    capability: CommandCapability,
    target_kind: TargetKind,
    expected_version: i64,
) -> CommandEnvelope {
    CommandEnvelope {
        session_id: session.session.session_id.clone(),
        session_generation: session.session.generation,
        device_id: session.session.device_id.clone(),
        command_id: command_id.to_owned(),
        idempotency_key: idempotency_key.to_owned(),
        expected_version,
        target: TargetScope {
            kind: target_kind,
            id: "target-1".to_owned(),
            project_id: Some("project-1".to_owned()),
        },
        audit_timestamp: NOW_MILLIS,
        capability,
        payload: json!({}),
    }
}
