def install_ib_trade_recheck(app: Any, namespace: dict[str, Any]) -> None:
    """Preserve the existing cash wrapper, invoking only IB trade scan at recheck."""
    if getattr(app.state, "ib_trade_recheck_installed", False):
        raise RuntimeError("IB_TRADE_RECHECK_ALREADY_INSTALLED")
    namespace["IBTradeFlexClient"] = DatedIBTradeFlexClient
    IBTradeSyncService._matches = staticmethod(_verified_legacy_matches)

    def recheck():
        daily = namespace.get("_ib_daily_run")
        if daily is not None:
            return daily()
        target = recheck_target(datetime.now(timezone.utc))
        # An authenticated request outside the bounded windows cannot replay trades.
        if target is None:
            return {"status": "SKIPPED", "reason": "OUTSIDE_RECHECK_WINDOW",
                    "financial_mutations": 0}
        try:
            runtime = namespace["_unified_runtime"]()
            upstream = getattr(runtime, "upstream", runtime)
            return run_sequence(upstream, runtime.stage_factory(), target)
        except (IBTradeError, RuntimeError, ValueError) as exc:
            code = str(exc)
            if code in {"IB_TRADE_SOURCE_PENDING", "IB_TRADE_FLEX_NOT_READY"}:
                return {"status": "PENDING_SOURCE", "target_date": target,
                        "reason": code, "financial_mutations": 0}
            raise HTTPException(status_code=503, detail=_safe_reason(exc)) from None

    def readiness():
        # No production state writes, Gmail changes, Orders or Sharesight POST.
        runtime = namespace["_unified_runtime"]()
        upstream = getattr(runtime, "upstream", runtime)
        state, _ = upstream.schwab.store.read()
        if not isinstance(state, dict):
            raise HTTPException(status_code=503, detail="IB_READINESS_STATE_MISSING")
        production_store = upstream.schwab.store
        upstream.schwab.store = _DetachedStore(state)
        if upstream.ib is None:
            raise HTTPException(status_code=503, detail="IB_TRADE_FLEX_NOT_CONFIGURED")
        upstream.ib.write_enabled = False
        # Preserve real journal identities, so this mirrors the production
        # scan. Never erase prior proofs or reinterpret historical aliases.
        stage = runtime.stage_factory()
        cash_state, _ = stage.store.read()
        stage.store = _DetachedStore(cash_state or {"schema_version": 1})
        target = latest_completed_weekday(datetime.now(timezone.utc)).isoformat()
        result = run_sequence(upstream, stage, target)
        result.update(readonly_acceptance=True, production_state_mutations=0,
                      financial_mutations=0)
        _save_readiness_audit(production_store, result)
        result["private_audit_mutations"] = 1
        return result

    app.add_api_route("/maintenance/ib-trade-recheck", recheck, methods=["GET"])
    app.add_api_route("/maintenance/ib-recheck-readiness", readiness, methods=["GET"])
    app.state.ib_trade_recheck_installed = True
