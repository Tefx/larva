import pytest

def test_manual_mode_semantics():
    pytest.fail("TODO: manual mode semantics - hides tools, rejects stale calls, prevents leases")

def test_confirm_mode_semantics():
    pytest.fail("TODO: confirm mode semantics - temporary borrow, 4 required choices (Borrow once, Deny, Auto-borrow for this session, Switch persistently)")

def test_auto_mode_semantics():
    pytest.fail("TODO: auto mode semantics - temporary borrow without UI confirmation, turn-scoped lease")

def test_free_mode_semantics():
    pytest.fail("TODO: free mode semantics - persistent switch, no automatic restore, no lease")

def test_user_manual_switch_clears_lease():
    pytest.fail("TODO: user manual switch clears active lease and wins over lease origin")
    
def test_unknown_mode_fallback():
    pytest.fail("TODO: unknown mode fails safe to confirm with warning and no alias mapping")

def test_restore_notices_never_chat_body():
    pytest.fail("TODO: restore notices are status/event/audit only, never chat-body text")
    
def test_restore_failure_preserves_state_requires_choice():
    pytest.fail("TODO: restore failure preserved, requires explicit user choice, no automatic safe-default fallback")

def test_generic_tasks_no_persona_lease():
    pytest.fail("TODO: generic deterministic tasks do not own persona leases")
