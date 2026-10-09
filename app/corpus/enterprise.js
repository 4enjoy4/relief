/* FauxCode profile: Enterprise Java — erp-core */
(function () {
'use strict';
const SRC = {};

/* ------------------------------------------------------------------ */
/* base for the generated primary file                                 */
/* ------------------------------------------------------------------ */

SRC.WORKFLOW_SERVICE = `package com.erp.core.approval;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.erp.core.audit.AuditEventPublisher;
import com.erp.core.audit.Audited;
import com.erp.core.common.WorkflowViolationException;
import com.erp.core.notify.ApproverNotifier;

// ERP-4471: multi-step approval workflow.
// Every request above the finance threshold visits up to three approvers
// before it becomes money. Below it, one approver and a spreadsheet nobody
// has opened since 2019.

@Service
public class ApprovalWorkflowService {

    private static final Logger logger = LoggerFactory.getLogger(ApprovalWorkflowService.class);

    static final BigDecimal FINANCE_THRESHOLD = new BigDecimal("10000.00");
    static final BigDecimal CFO_THRESHOLD = new BigDecimal("250000.00");

    private final ApprovalRepository repository;
    private final AuditEventPublisher audit;
    private final ApproverNotifier notifier;
    private final Clock clock;

    public ApprovalWorkflowService(ApprovalRepository repository,
                                   AuditEventPublisher audit,
                                   ApproverNotifier notifier,
                                   Clock clock) {
        this.repository = repository;
        this.audit = audit;
        this.notifier = notifier;
        this.clock = clock;
    }

    @Transactional
    @Audited(action = "approval.submit")
    public ApprovalRequest submit(UUID requestId, String submittedBy) {
        ApprovalRequest request = load(requestId);
        Instant now = clock.instant();
        request.transitionTo(ApprovalState.PENDING, submittedBy, now);
        request.attachSteps(planSteps(request, now));
        repository.save(request);
        notifier.notifyPending(request, request.currentStep().orElseThrow());
        audit.transition(request, ApprovalState.DRAFT, ApprovalState.PENDING, submittedBy);
        logger.info("request {} submitted by {} with {} step(s)", requestId, submittedBy, request.getSteps().size());
        return request;
    }

    @Transactional
    @Audited(action = "approval.approve")
    public ApprovalRequest approve(UUID requestId, String approver, String comment) {
        ApprovalRequest request = load(requestId);
        ApprovalStep step = openStep(request);
        ApprovalState before = request.getState();
        step.decide(ApprovalStep.Decision.APPROVED, approver, comment, clock.instant());
        if (request.hasRemainingSteps()) {
            request.advance();
            notifier.notifyPending(request, request.currentStep().orElseThrow());
        } else {
            request.transitionTo(ApprovalState.APPROVED, approver, clock.instant());
            notifier.notifyCompleted(request);
        }
        audit.transition(request, before, request.getState(), approver);
        logger.info("request {} step {} approved by {}", requestId, step.getSequence(), approver);
        return repository.save(request);
    }

    @Transactional
    @Audited(action = "approval.reject")
    public ApprovalRequest reject(UUID requestId, String approver, String reason) {
        if (reason == null || reason.isBlank()) {
            // "No" is a complete sentence. It is not, however, a complete audit trail.
            throw new WorkflowViolationException("a rejection requires a reason");
        }
        ApprovalRequest request = load(requestId);
        ApprovalStep step = openStep(request);
        ApprovalState before = request.getState();
        step.decide(ApprovalStep.Decision.REJECTED, approver, reason, clock.instant());
        request.transitionTo(ApprovalState.REJECTED, approver, clock.instant());
        notifier.notifyRejected(request, reason);
        audit.transition(request, before, ApprovalState.REJECTED, approver);
        logger.info("request {} rejected by {} at step {}", requestId, approver, step.getSequence());
        return repository.save(request);
    }

    private ApprovalRequest load(UUID requestId) {
        return repository.findWithLockById(requestId)
                .orElseThrow(() -> new WorkflowViolationException("unknown approval request " + requestId));
    }

    private ApprovalStep openStep(ApprovalRequest request) {
        if (!request.getState().isOpen()) {
            throw new WorkflowViolationException("request " + request.getId() + " is " + request.getState());
        }
        return request.currentStep()
                .filter(ApprovalStep::isOpen)
                .orElseThrow(() -> new WorkflowViolationException("request " + request.getId() + " has no open step"));
    }

    private List<ApprovalStep> planSteps(ApprovalRequest request, Instant submittedAt) {
        List<ApprovalStep> steps = new ArrayList<>();
        steps.add(ApprovalStep.of(1, "COST_CENTER_OWNER", request.getCostCenterCode(), submittedAt));
        if (request.getAmount().compareTo(FINANCE_THRESHOLD) >= 0) {
            steps.add(ApprovalStep.of(2, "FINANCE_CONTROLLER", request.getCostCenterCode(), submittedAt));
        }
        if (request.getAmount().compareTo(CFO_THRESHOLD) >= 0) {
            // Above this line the CFO wants to know. Below it the CFO wants to not know.
            steps.add(ApprovalStep.of(3, "CFO", "GLOBAL", submittedAt));
        }
        return steps;
    }
}
`;

/* ------------------------------------------------------------------ */
/* base for the generated secondary file (Flyway migration)            */
/* ------------------------------------------------------------------ */

SRC.MIGRATION = `-- V23__approval_workflow.sql
-- ERP-4471: multi-step approval workflow for purchase orders and invoices.
--
-- Flyway runs this exactly once per environment. If you are reading this
-- because it ran more than once, stop reading and page the DBA on-call.
-- The DBA on-call is also you. Sorry.

SET search_path TO erp, public;

CREATE TABLE IF NOT EXISTS erp.approval_request (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type        VARCHAR(32)     NOT NULL,
    subject_id          UUID            NOT NULL,
    cost_center_code    VARCHAR(16)     NOT NULL,
    amount              NUMERIC(18, 2)  NOT NULL CHECK (amount >= 0),
    currency            CHAR(3)         NOT NULL DEFAULT 'EUR',
    state               VARCHAR(24)     NOT NULL DEFAULT 'DRAFT',
    current_step        INTEGER         NOT NULL DEFAULT 0,
    submitted_by        VARCHAR(128),
    submitted_at        TIMESTAMPTZ,
    decided_at          TIMESTAMPTZ,
    version             BIGINT          NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    CONSTRAINT approval_request_subject_type_chk
        CHECK (subject_type IN ('PURCHASE_ORDER', 'INVOICE')),
    CONSTRAINT approval_request_state_chk
        CHECK (state IN ('DRAFT', 'PENDING', 'ESCALATED', 'APPROVED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT approval_request_subject_uq
        UNIQUE (subject_type, subject_id)
);

COMMENT ON TABLE erp.approval_request
    IS 'One row per thing that needs signatures before it becomes money. See ADR-0007.';
COMMENT ON COLUMN erp.approval_request.version
    IS 'Optimistic lock. Two approvers clicking at once is not a race condition, it is a Tuesday.';
COMMENT ON COLUMN erp.approval_request.current_step
    IS '0 while DRAFT; otherwise the sequence of the step currently awaiting a decision.';
`;

/* ------------------------------------------------------------------ */
/* approval package                                                    */
/* ------------------------------------------------------------------ */

SRC.APPROVAL_STATE = `package com.erp.core.approval;

import java.util.EnumSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Lifecycle of an {@link ApprovalRequest}.
 *
 * The transition table below is the single source of truth. The diagram in
 * ADR-0007 is a well-meaning approximation of it, and the slide in the
 * quarterly review is a well-meaning approximation of the diagram.
 */
public enum ApprovalState {

    /** Created, not yet submitted. Editable. Nobody has been bothered. */
    DRAFT,

    /** Submitted; the current step is waiting on an approver. */
    PENDING,

    /** A step blew through its SLA and the escalation role now owns it. */
    ESCALATED,

    /** Every planned step approved. Terminal. */
    APPROVED,

    /** Any step rejected. The requester may edit and resubmit from DRAFT. */
    REJECTED,

    /** Withdrawn by the requester before a decision. Terminal. */
    CANCELLED;

    private static final Map<ApprovalState, Set<ApprovalState>> TRANSITIONS = Map.of(
            DRAFT, EnumSet.of(PENDING, CANCELLED),
            PENDING, EnumSet.of(PENDING, ESCALATED, APPROVED, REJECTED, CANCELLED),
            ESCALATED, EnumSet.of(APPROVED, REJECTED, CANCELLED),
            APPROVED, EnumSet.noneOf(ApprovalState.class),
            REJECTED, EnumSet.of(DRAFT),
            CANCELLED, EnumSet.noneOf(ApprovalState.class));

    public boolean canTransitionTo(ApprovalState target) {
        return target != null && TRANSITIONS.get(this).contains(target);
    }

    public Set<ApprovalState> successors() {
        return Set.copyOf(TRANSITIONS.get(this));
    }

    /** Terminal states never change again. Neither, in practice, do the opinions behind them. */
    public boolean isTerminal() {
        return this == APPROVED || this == CANCELLED;
    }

    /** Open states accept approve/reject decisions. */
    public boolean isOpen() {
        return this == PENDING || this == ESCALATED;
    }

    /**
     * Tolerant parser for values coming out of the database and, occasionally,
     * out of the legacy reporting job that still writes lower case.
     */
    public static ApprovalState fromColumn(String raw) {
        if (raw == null || raw.isBlank()) {
            return DRAFT;
        }
        return ApprovalState.valueOf(raw.trim().toUpperCase(Locale.ROOT));
    }
}
`;

SRC.APPROVAL_REQUEST = `package com.erp.core.approval;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EntityListeners;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import com.erp.core.common.WorkflowViolationException;

/**
 * Something that needs signatures before it becomes money.
 * Backed by erp.approval_request (V23__approval_workflow.sql).
 *
 * All state changes go through methods on this class. There are no setters,
 * which has upset exactly one mapping library and zero auditors.
 */
@Entity
@Table(name = "approval_request", schema = "erp")
@EntityListeners(AuditingEntityListener.class)
public class ApprovalRequest {

    public enum SubjectType { PURCHASE_ORDER, INVOICE }

    @Id
    private UUID id;

    @Enumerated(EnumType.STRING)
    @Column(name = "subject_type", nullable = false, length = 32)
    private SubjectType subjectType;

    @Column(name = "subject_id", nullable = false)
    private UUID subjectId;

    @Column(name = "cost_center_code", nullable = false, length = 16)
    private String costCenterCode;

    @Column(nullable = false, precision = 18, scale = 2)
    private BigDecimal amount;

    @Column(nullable = false, length = 3)
    private String currency;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 24)
    private ApprovalState state = ApprovalState.DRAFT;

    @Column(name = "current_step", nullable = false)
    private int currentStep;

    @Column(name = "submitted_by", length = 128)
    private String submittedBy;

    @Column(name = "submitted_at")
    private Instant submittedAt;

    @Column(name = "decided_at")
    private Instant decidedAt;

    @Version
    private long version;

    @CreatedDate
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @LastModifiedDate
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @OneToMany(mappedBy = "request", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("sequence ASC")
    private List<ApprovalStep> steps = new ArrayList<>();

    protected ApprovalRequest() {
        // JPA insists. We comply.
    }

    public static ApprovalRequest draft(SubjectType type, UUID subjectId, String costCenterCode,
                                        BigDecimal amount, String currency) {
        ApprovalRequest r = new ApprovalRequest();
        r.id = UUID.randomUUID();
        r.subjectType = type;
        r.subjectId = subjectId;
        r.costCenterCode = costCenterCode;
        r.amount = amount;
        r.currency = currency;
        return r;
    }

    public void transitionTo(ApprovalState target, String actor, Instant at) {
        if (!state.canTransitionTo(target)) {
            throw new WorkflowViolationException(
                    "illegal transition " + state + " -> " + target + " for request " + id);
        }
        if (target == ApprovalState.PENDING && state == ApprovalState.DRAFT) {
            submittedBy = actor;
            submittedAt = at;
            currentStep = 1;
        }
        if (target.isTerminal() || target == ApprovalState.REJECTED) {
            decidedAt = at;
        }
        state = target;
    }

    public void attachSteps(List<ApprovalStep> planned) {
        if (planned.isEmpty()) {
            throw new WorkflowViolationException("a workflow with zero steps is called a purchase");
        }
        steps.clear();
        for (ApprovalStep step : planned) {
            step.bindTo(this);
            steps.add(step);
        }
    }

    public Optional<ApprovalStep> currentStep() {
        return steps.stream().filter(s -> s.getSequence() == currentStep).findFirst();
    }

    public boolean hasRemainingSteps() {
        return steps.stream().anyMatch(s -> s.getSequence() > currentStep);
    }

    public void advance() {
        if (!hasRemainingSteps()) {
            throw new WorkflowViolationException("request " + id + " has no further steps");
        }
        currentStep += 1;
    }

    public UUID getId() { return id; }
    public SubjectType getSubjectType() { return subjectType; }
    public UUID getSubjectId() { return subjectId; }
    public String getCostCenterCode() { return costCenterCode; }
    public BigDecimal getAmount() { return amount; }
    public String getCurrency() { return currency; }
    public ApprovalState getState() { return state; }
    public int getCurrentStep() { return currentStep; }
    public String getSubmittedBy() { return submittedBy; }
    public Instant getSubmittedAt() { return submittedAt; }
    public Instant getDecidedAt() { return decidedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }
    public List<ApprovalStep> getSteps() { return List.copyOf(steps); }
}
`;

SRC.APPROVAL_STEP = `package com.erp.core.approval;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

import com.erp.core.common.WorkflowViolationException;

/**
 * One signature slot in an {@link ApprovalRequest}. Steps are decided strictly
 * in sequence; there is no "approve out of order" because there is no
 * "explain to internal audit out of order".
 */
@Entity
@Table(name = "approval_step", schema = "erp")
public class ApprovalStep {

    public enum Decision { PENDING, APPROVED, REJECTED, SKIPPED }

    /** ERP-4471: approvers get two working days before the reminder machine wakes up. */
    static final Duration DEFAULT_SLA = Duration.ofHours(48);

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "request_id", nullable = false)
    private ApprovalRequest request;

    @Column(nullable = false)
    private int sequence;

    @Column(name = "approver_role", nullable = false, length = 64)
    private String role;

    @Column(nullable = false, length = 64)
    private String scope;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private Decision decision = Decision.PENDING;

    @Column(name = "decided_by", length = 128)
    private String decidedBy;

    @Column(name = "decided_at")
    private Instant decidedAt;

    @Column(name = "due_at", nullable = false)
    private Instant dueAt;

    @Column(length = 1024)
    private String comment;

    protected ApprovalStep() {
    }

    public static ApprovalStep of(int sequence, String role, String scope, Instant from) {
        ApprovalStep step = new ApprovalStep();
        step.id = UUID.randomUUID();
        step.sequence = sequence;
        step.role = role;
        step.scope = scope;
        step.dueAt = from.plus(DEFAULT_SLA);
        return step;
    }

    void bindTo(ApprovalRequest owner) {
        this.request = owner;
    }

    public void decide(Decision outcome, String actor, String note, Instant at) {
        if (decision != Decision.PENDING) {
            throw new WorkflowViolationException("step " + sequence + " already decided: " + decision);
        }
        if (outcome == Decision.PENDING) {
            throw new WorkflowViolationException("deciding to remain undecided is not a decision");
        }
        decision = outcome;
        decidedBy = actor;
        decidedAt = at;
        comment = note;
    }

    public boolean isOpen() {
        return decision == Decision.PENDING;
    }

    public boolean isOverdue(Instant now) {
        return isOpen() && now.isAfter(dueAt);
    }

    public UUID getId() { return id; }
    public ApprovalRequest getRequest() { return request; }
    public int getSequence() { return sequence; }
    public String getRole() { return role; }
    public String getScope() { return scope; }
    public Decision getDecision() { return decision; }
    public String getDecidedBy() { return decidedBy; }
    public Instant getDecidedAt() { return decidedAt; }
    public Instant getDueAt() { return dueAt; }
    public String getComment() { return comment; }
}
`;

SRC.APPROVAL_REPOSITORY = `package com.erp.core.approval;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.erp.core.approval.ApprovalRequest.SubjectType;

public interface ApprovalRepository extends JpaRepository<ApprovalRequest, UUID> {

    /** Row lock for the duration of a decision. Two approvers, one row, zero surprises. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from ApprovalRequest r left join fetch r.steps where r.id = :id")
    Optional<ApprovalRequest> findWithLockById(@Param("id") UUID id);

    Optional<ApprovalRequest> findBySubjectTypeAndSubjectId(SubjectType subjectType, UUID subjectId);

    List<ApprovalRequest> findByStateOrderBySubmittedAtAsc(ApprovalState state);

    Page<ApprovalRequest> findByCostCenterCodeAndStateIn(String costCenterCode,
                                                         Collection<ApprovalState> states,
                                                         Pageable pageable);

    /**
     * Requests whose current step has been waiting longer than its SLA.
     * Used by the escalation job (ERP-4471) and, informally, by management.
     */
    @Query("""
            select distinct r from ApprovalRequest r
              join r.steps s
             where r.state = com.erp.core.approval.ApprovalState.PENDING
               and s.sequence = r.currentStep
               and s.decision = com.erp.core.approval.ApprovalStep.Decision.PENDING
               and s.dueAt < :cutoff
            """)
    List<ApprovalRequest> findOverdue(@Param("cutoff") Instant cutoff);

    @Query("""
            select count(r) from ApprovalRequest r
              join r.steps s
             where r.state in (com.erp.core.approval.ApprovalState.PENDING,
                               com.erp.core.approval.ApprovalState.ESCALATED)
               and s.sequence = r.currentStep
               and s.role = :role
            """)
    long countInboxForRole(@Param("role") String role);

    @Query("""
            select r from ApprovalRequest r
             where r.decidedAt between :from and :to
             order by r.decidedAt desc
            """)
    List<ApprovalRequest> findDecidedBetween(@Param("from") Instant from, @Param("to") Instant to);
}
`;

SRC.APPROVAL_DTO = `package com.erp.core.approval;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Wire shapes for /api/v1/approvals. Records only; the entities stay behind the counter.
 */
public final class ApprovalDto {

    private ApprovalDto() {
    }

    public record DecisionRequest(
            @Size(max = 1024) String comment) {
    }

    public record RejectRequest(
            @NotBlank(message = "a rejection requires a reason") @Size(max = 1024) String reason) {
    }

    public record StepView(
            int sequence,
            String role,
            String scope,
            String decision,
            String decidedBy,
            Instant decidedAt,
            Instant dueAt,
            String comment) {

        static StepView from(ApprovalStep step) {
            return new StepView(step.getSequence(), step.getRole(), step.getScope(),
                    step.getDecision().name(), step.getDecidedBy(), step.getDecidedAt(),
                    step.getDueAt(), step.getComment());
        }
    }

    public record RequestView(
            UUID id,
            String subjectType,
            UUID subjectId,
            String costCenter,
            BigDecimal amount,
            String currency,
            String state,
            int currentStep,
            String submittedBy,
            Instant submittedAt,
            Instant decidedAt,
            long version,
            List<StepView> steps) {

        static RequestView from(ApprovalRequest r) {
            return new RequestView(r.getId(), r.getSubjectType().name(), r.getSubjectId(),
                    r.getCostCenterCode(), r.getAmount(), r.getCurrency(), r.getState().name(),
                    r.getCurrentStep(), r.getSubmittedBy(), r.getSubmittedAt(), r.getDecidedAt(),
                    r.getVersion(), r.getSteps().stream().map(StepView::from).toList());
        }
    }

    public record InboxItem(
            UUID id,
            String subjectType,
            BigDecimal amount,
            String currency,
            String costCenter,
            int sequence,
            Instant dueAt,
            boolean overdue) {

        static InboxItem from(ApprovalRequest r, Instant now) {
            ApprovalStep step = r.currentStep().orElseThrow();
            return new InboxItem(r.getId(), r.getSubjectType().name(), r.getAmount(), r.getCurrency(),
                    r.getCostCenterCode(), step.getSequence(), step.getDueAt(), step.isOverdue(now));
        }
    }

    /** Plain page envelope. Spring's Page serializes fine; the frontend team disagrees. */
    public record PagedResponse<T>(List<T> items, int page, int size, long total) {
    }
}
`;

SRC.APPROVAL_CONTROLLER = `package com.erp.core.approval;

import java.time.Clock;
import java.util.EnumSet;
import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.erp.core.approval.ApprovalDto.DecisionRequest;
import com.erp.core.approval.ApprovalDto.InboxItem;
import com.erp.core.approval.ApprovalDto.PagedResponse;
import com.erp.core.approval.ApprovalDto.RejectRequest;
import com.erp.core.approval.ApprovalDto.RequestView;
import com.erp.core.common.NotFoundException;

/**
 * ERP-4471: HTTP surface of the approval workflow.
 * The frontend team asked for "just three endpoints". This is what three grows into.
 */
@RestController
@RequestMapping(path = "/api/v1/approvals", produces = "application/json")
public class ApprovalController {

    private static final int MAX_PAGE_SIZE = 200;
    private static final String ROLE_CLAIM = "erp_roles";

    private final ApprovalWorkflowService workflow;
    private final ApprovalRepository repository;
    private final Clock clock;

    public ApprovalController(ApprovalWorkflowService workflow, ApprovalRepository repository, Clock clock) {
        this.workflow = workflow;
        this.repository = repository;
        this.clock = clock;
    }

    @GetMapping("/{id}")
    @PreAuthorize("hasAnyRole('REQUESTER', 'APPROVER', 'FINANCE')")
    public RequestView get(@PathVariable UUID id) {
        return repository.findById(id)
                .map(RequestView::from)
                .orElseThrow(() -> new NotFoundException("approval request " + id));
    }

    @PostMapping("/{id}/submit")
    @PreAuthorize("hasRole('REQUESTER')")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public RequestView submit(@PathVariable UUID id, @AuthenticationPrincipal Jwt principal) {
        return RequestView.from(workflow.submit(id, actor(principal)));
    }

    @PostMapping("/{id}/approve")
    @PreAuthorize("hasRole('APPROVER')")
    public RequestView approve(@PathVariable UUID id,
                               @Valid @RequestBody DecisionRequest body,
                               @AuthenticationPrincipal Jwt principal) {
        return RequestView.from(workflow.approve(id, actor(principal), body.comment()));
    }

    @PostMapping("/{id}/reject")
    @PreAuthorize("hasRole('APPROVER')")
    public RequestView reject(@PathVariable UUID id,
                              @Valid @RequestBody RejectRequest body,
                              @AuthenticationPrincipal Jwt principal) {
        return RequestView.from(workflow.reject(id, actor(principal), body.reason()));
    }

    @GetMapping
    @PreAuthorize("hasAnyRole('APPROVER', 'FINANCE')")
    public PagedResponse<RequestView> list(@RequestParam String costCenter,
                                           @RequestParam(defaultValue = "PENDING,ESCALATED") List<ApprovalState> states,
                                           @RequestParam(defaultValue = "0") int page,
                                           @RequestParam(defaultValue = "50") int size) {
        int bounded = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
        Page<ApprovalRequest> result = repository.findByCostCenterCodeAndStateIn(
                costCenter, EnumSet.copyOf(states),
                PageRequest.of(page, bounded, Sort.by("submittedAt").ascending()));
        return new PagedResponse<>(result.map(RequestView::from).getContent(), page, bounded, result.getTotalElements());
    }

    @GetMapping("/inbox")
    @PreAuthorize("hasRole('APPROVER')")
    public List<InboxItem> inbox(@AuthenticationPrincipal Jwt principal) {
        List<String> roles = rolesOf(principal);
        // Oldest first, so the thing you have been avoiding is always on top.
        return repository.findByStateOrderBySubmittedAtAsc(ApprovalState.PENDING).stream()
                .filter(r -> r.currentStep().map(s -> roles.contains(s.getRole())).orElse(false))
                .map(r -> InboxItem.from(r, clock.instant()))
                .toList();
    }

    private static String actor(Jwt principal) {
        String preferred = principal.getClaimAsString("preferred_username");
        return preferred != null ? preferred : principal.getSubject();
    }

    private static List<String> rolesOf(Jwt principal) {
        List<String> roles = principal.getClaimAsStringList(ROLE_CLAIM);
        return roles != null ? roles : List.of();
    }
}
`;

/* ------------------------------------------------------------------ */
/* invoice package                                                     */
/* ------------------------------------------------------------------ */

SRC.INVOICE_SERVICE = `package com.erp.core.invoice;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.LocalDate;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.erp.core.approval.ApprovalRepository;
import com.erp.core.approval.ApprovalRequest;
import com.erp.core.approval.ApprovalRequest.SubjectType;
import com.erp.core.approval.ApprovalWorkflowService;
import com.erp.core.audit.Audited;
import com.erp.core.common.NotFoundException;
import com.erp.core.common.WorkflowViolationException;
import com.erp.core.procurement.PurchaseOrder;
import com.erp.core.procurement.PurchaseOrderRepository;

/**
 * ERP-4462: three-way match. An invoice is paid when the purchase order, the
 * goods receipt and the invoice all agree on what happened. When they do not,
 * the invoice goes to approval, where a human decides which document is lying.
 */
@Service
public class InvoiceService {

    private static final Logger log = LoggerFactory.getLogger(InvoiceService.class);

    /** Variance we tolerate without asking anyone. Finance picked the number; we picked the scale. */
    static final BigDecimal MATCH_TOLERANCE = new BigDecimal("0.02");
    private static final int VARIANCE_SCALE = 6;

    private final InvoiceRepository invoices;
    private final PurchaseOrderRepository purchaseOrders;
    private final ApprovalRepository approvals;
    private final ApprovalWorkflowService workflow;
    private final Clock clock;

    public InvoiceService(InvoiceRepository invoices,
                          PurchaseOrderRepository purchaseOrders,
                          ApprovalRepository approvals,
                          ApprovalWorkflowService workflow,
                          Clock clock) {
        this.invoices = invoices;
        this.purchaseOrders = purchaseOrders;
        this.approvals = approvals;
        this.workflow = workflow;
        this.clock = clock;
    }

    @Transactional
    @Audited(action = "invoice.register")
    public Invoice register(RegisterInvoiceCommand command, String actor) {
        if (invoices.existsByVendorIdAndInvoiceNumber(command.vendorId(), command.invoiceNumber())) {
            throw new WorkflowViolationException(
                    "invoice " + command.invoiceNumber() + " already registered for vendor " + command.vendorId());
        }
        PurchaseOrder order = purchaseOrders.findById(command.purchaseOrderId())
                .orElseThrow(() -> new NotFoundException("purchase order " + command.purchaseOrderId()));
        if (!order.getCurrency().equals(command.currency())) {
            throw new WorkflowViolationException(
                    "invoice currency " + command.currency() + " does not match order currency " + order.getCurrency());
        }

        Invoice invoice = Invoice.from(command, order, clock.instant());
        invoices.save(invoice);

        MatchResult match = threeWayMatch(invoice, order);
        if (match.withinTolerance()) {
            invoice.markMatched(clock.instant());
            log.info("invoice {} auto-matched against {} (variance {})",
                    invoice.getInvoiceNumber(), order.getNumber(), match.variance());
        } else {
            ApprovalRequest request = ApprovalRequest.draft(SubjectType.INVOICE, invoice.getId(),
                    order.getCostCenterCode(), invoice.getTotal(), invoice.getCurrency());
            approvals.save(request);
            invoice.markPendingApproval(request.getId());
            workflow.submit(request.getId(), actor);
            log.warn("invoice {} differs from {} by {} ({}), approval {} opened",
                    invoice.getInvoiceNumber(), order.getNumber(), match.difference(), match.variance(), request.getId());
        }
        return invoices.save(invoice);
    }

    /**
     * Compares the invoice against what was received, or against what was ordered
     * when nothing has been received yet. The warehouse scans things eventually.
     */
    MatchResult threeWayMatch(Invoice invoice, PurchaseOrder order) {
        BigDecimal reference = order.getReceivedValue().signum() > 0 ? order.getReceivedValue() : order.getTotal();
        BigDecimal invoiced = invoice.getTotal();
        if (reference.signum() == 0) {
            // A zero-value order with a non-zero invoice. Someone is being creative.
            return new MatchResult(invoiced, BigDecimal.ONE, false);
        }
        BigDecimal difference = invoiced.subtract(reference);
        BigDecimal variance = difference.abs().divide(reference, VARIANCE_SCALE, RoundingMode.HALF_UP);
        return new MatchResult(difference, variance, variance.compareTo(MATCH_TOLERANCE) <= 0);
    }

    @Transactional
    public void onApprovalDecided(UUID invoiceId, boolean approved, String actor) {
        Invoice invoice = invoices.findById(invoiceId)
                .orElseThrow(() -> new NotFoundException("invoice " + invoiceId));
        if (approved) {
            invoice.markApproved(clock.instant());
        } else {
            invoice.markRejected();
        }
        log.info("invoice {} {} by {}", invoice.getInvoiceNumber(), approved ? "approved" : "rejected", actor);
        invoices.save(invoice);
    }

    public record RegisterInvoiceCommand(
            UUID vendorId,
            UUID purchaseOrderId,
            String invoiceNumber,
            String currency,
            BigDecimal total,
            LocalDate issuedOn) {
    }

    record MatchResult(BigDecimal difference, BigDecimal variance, boolean withinTolerance) {
    }
}
`;

SRC.INVOICE = `package com.erp.core.invoice;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

import com.erp.core.common.WorkflowViolationException;
import com.erp.core.invoice.InvoiceService.RegisterInvoiceCommand;
import com.erp.core.procurement.PurchaseOrder;

/**
 * A vendor's opinion of what we owe them. Backed by erp.invoice and erp.invoice_line.
 */
@Entity
@Table(name = "invoice", schema = "erp")
public class Invoice {

    public enum Status { REGISTERED, MATCHED, PENDING_APPROVAL, APPROVED, REJECTED, PAID }

    @Id
    private UUID id;

    @Column(name = "vendor_id", nullable = false)
    private UUID vendorId;

    @Column(name = "purchase_order_id", nullable = false)
    private UUID purchaseOrderId;

    @Column(name = "invoice_number", nullable = false, length = 64)
    private String invoiceNumber;

    @Column(nullable = false, length = 3)
    private String currency;

    @Column(nullable = false, precision = 18, scale = 2)
    private BigDecimal total;

    @Column(name = "issued_on", nullable = false)
    private LocalDate issuedOn;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 24)
    private Status status = Status.REGISTERED;

    @Column(name = "approval_request_id")
    private UUID approvalRequestId;

    @Column(name = "registered_at", nullable = false, updatable = false)
    private Instant registeredAt;

    @Column(name = "matched_at")
    private Instant matchedAt;

    @Version
    private long version;

    @OneToMany(mappedBy = "invoice", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("lineNo ASC")
    private List<Line> lines = new ArrayList<>();

    protected Invoice() {
    }

    public static Invoice from(RegisterInvoiceCommand command, PurchaseOrder order, Instant now) {
        Invoice invoice = new Invoice();
        invoice.id = UUID.randomUUID();
        invoice.vendorId = command.vendorId();
        invoice.purchaseOrderId = order.getId();
        invoice.invoiceNumber = command.invoiceNumber().trim();
        invoice.currency = command.currency();
        invoice.total = command.total();
        invoice.issuedOn = command.issuedOn();
        invoice.registeredAt = now;
        return invoice;
    }

    public void markMatched(Instant at) {
        require(Status.REGISTERED);
        status = Status.MATCHED;
        matchedAt = at;
    }

    public void markPendingApproval(UUID requestId) {
        require(Status.REGISTERED);
        approvalRequestId = requestId;
        status = Status.PENDING_APPROVAL;
    }

    public void markApproved(Instant at) {
        require(Status.PENDING_APPROVAL);
        status = Status.APPROVED;
        matchedAt = at;
    }

    public void markRejected() {
        require(Status.PENDING_APPROVAL);
        status = Status.REJECTED;
    }

    public void markPaid() {
        // The only transition with a hard prerequisite and a soft deadline.
        require(Status.MATCHED, Status.APPROVED);
        status = Status.PAID;
    }

    private void require(Status... allowed) {
        for (Status s : allowed) {
            if (s == status) {
                return;
            }
        }
        throw new WorkflowViolationException("invoice " + invoiceNumber + " is " + status);
    }

    public UUID getId() { return id; }
    public UUID getVendorId() { return vendorId; }
    public UUID getPurchaseOrderId() { return purchaseOrderId; }
    public String getInvoiceNumber() { return invoiceNumber; }
    public String getCurrency() { return currency; }
    public BigDecimal getTotal() { return total; }
    public LocalDate getIssuedOn() { return issuedOn; }
    public Status getStatus() { return status; }
    public UUID getApprovalRequestId() { return approvalRequestId; }
    public Instant getRegisteredAt() { return registeredAt; }
    public Instant getMatchedAt() { return matchedAt; }
    public List<Line> getLines() { return List.copyOf(lines); }

    @Entity
    @Table(name = "invoice_line", schema = "erp")
    public static class Line {

        @Id
        private UUID id;

        @ManyToOne(fetch = FetchType.LAZY, optional = false)
        @JoinColumn(name = "invoice_id", nullable = false)
        private Invoice invoice;

        @Column(name = "line_no", nullable = false)
        private int lineNo;

        @Column(nullable = false, length = 256)
        private String description;

        @Column(nullable = false, precision = 12, scale = 3)
        private BigDecimal quantity;

        @Column(name = "unit_price", nullable = false, precision = 18, scale = 4)
        private BigDecimal unitPrice;

        protected Line() {
        }

        public BigDecimal amount() {
            return quantity.multiply(unitPrice);
        }

        public int getLineNo() { return lineNo; }
        public String getDescription() { return description; }
        public BigDecimal getQuantity() { return quantity; }
        public BigDecimal getUnitPrice() { return unitPrice; }
    }
}
`;

/* ------------------------------------------------------------------ */
/* procurement package                                                 */
/* ------------------------------------------------------------------ */

SRC.PURCHASE_ORDER_SERVICE = `package com.erp.core.procurement;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.time.Year;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.erp.core.approval.ApprovalRepository;
import com.erp.core.approval.ApprovalRequest;
import com.erp.core.approval.ApprovalRequest.SubjectType;
import com.erp.core.approval.ApprovalWorkflowService;
import com.erp.core.audit.Audited;
import com.erp.core.common.NotFoundException;
import com.erp.core.common.WorkflowViolationException;

/**
 * Purchase orders from draft to closed. Anything with a price tag goes through
 * {@link ApprovalWorkflowService} first (ERP-4471); anything without a price tag
 * is not a purchase order, it is a wish.
 */
@Service
public class PurchaseOrderService {

    private static final Logger log = LoggerFactory.getLogger(PurchaseOrderService.class);

    private final PurchaseOrderRepository orders;
    private final VendorRepository vendors;
    private final ApprovalRepository approvals;
    private final ApprovalWorkflowService workflow;
    private final ApplicationEventPublisher events;
    private final Clock clock;

    public PurchaseOrderService(PurchaseOrderRepository orders,
                                VendorRepository vendors,
                                ApprovalRepository approvals,
                                ApprovalWorkflowService workflow,
                                ApplicationEventPublisher events,
                                Clock clock) {
        this.orders = orders;
        this.vendors = vendors;
        this.approvals = approvals;
        this.workflow = workflow;
        this.events = events;
        this.clock = clock;
    }

    @Transactional
    @Audited(action = "po.create")
    public PurchaseOrder create(CreateOrderCommand command, String actor) {
        Vendor vendor = vendors.findById(command.vendorId())
                .orElseThrow(() -> new NotFoundException("vendor " + command.vendorId()));
        if (!vendor.isActive()) {
            throw new WorkflowViolationException("vendor " + vendor.getName() + " is blocked for new orders");
        }
        if (command.total() == null || command.total().signum() <= 0) {
            throw new WorkflowViolationException("a purchase order needs a positive total");
        }
        PurchaseOrder order = PurchaseOrder.draft(nextNumber(), vendor.getId(), command.costCenterCode(),
                vendor.getCurrency(), command.total(), actor, command.expectedOn(), clock.instant());
        orders.save(order);
        log.info("purchase order {} created by {} for {} {}", order.getNumber(), actor, order.getTotal(), order.getCurrency());
        return order;
    }

    @Transactional
    @Audited(action = "po.submit")
    public PurchaseOrder submitForApproval(UUID orderId, String actor) {
        PurchaseOrder order = load(orderId);
        ApprovalRequest request = ApprovalRequest.draft(SubjectType.PURCHASE_ORDER, order.getId(),
                order.getCostCenterCode(), order.getTotal(), order.getCurrency());
        approvals.save(request);
        order.markPendingApproval(request.getId());
        workflow.submit(request.getId(), actor);
        return orders.save(order);
    }

    @Transactional
    public void onApprovalDecided(UUID orderId, boolean approved, String actor) {
        PurchaseOrder order = load(orderId);
        if (approved) {
            order.markApproved();
            order.markOrdered();
            events.publishEvent(new PurchaseOrderOrdered(order.getId(), order.getNumber(), order.getVendorId()));
        } else {
            order.cancel();
        }
        log.info("purchase order {} {} by {}", order.getNumber(), approved ? "approved" : "rejected", actor);
        orders.save(order);
    }

    @Transactional
    @Audited(action = "po.receive")
    public PurchaseOrder receiveGoods(UUID orderId, BigDecimal value, String actor) {
        PurchaseOrder order = load(orderId);
        if (value.compareTo(order.outstandingValue()) > 0) {
            // Receiving more than was ordered is either a gift or a mistake. Neither is booked here.
            throw new WorkflowViolationException("received value exceeds outstanding value on " + order.getNumber());
        }
        LocalDate today = LocalDate.now(clock);
        if (order.getExpectedOn() != null && order.getExpectedOn().isBefore(today.minusDays(30))) {
            log.warn("purchase order {} received by {} more than 30 days late", order.getNumber(), actor);
        }
        order.receive(value);
        return orders.save(order);
    }

    @Transactional
    @Audited(action = "po.close")
    public PurchaseOrder close(UUID orderId) {
        PurchaseOrder order = load(orderId);
        order.close();
        return orders.save(order);
    }

    private PurchaseOrder load(UUID orderId) {
        return orders.findById(orderId)
                .orElseThrow(() -> new NotFoundException("purchase order " + orderId));
    }

    private String nextNumber() {
        // PO-2026-000813. The width was chosen in 2011 and revisited, briefly, in 2024.
        return "PO-" + Year.now(clock).getValue() + "-" + String.format("%06d", orders.nextSequenceValue());
    }

    public record CreateOrderCommand(UUID vendorId, String costCenterCode, BigDecimal total, LocalDate expectedOn) {
    }

    public record PurchaseOrderOrdered(UUID orderId, String number, UUID vendorId) {
    }
}
`;

SRC.PURCHASE_ORDER = `package com.erp.core.procurement;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

import com.erp.core.common.WorkflowViolationException;

/**
 * A promise to pay a vendor for something, once approval agrees it was a good idea.
 * Backed by erp.purchase_order.
 */
@Entity
@Table(name = "purchase_order", schema = "erp")
public class PurchaseOrder {

    public enum Status {
        DRAFT, PENDING_APPROVAL, APPROVED, ORDERED, PARTIALLY_RECEIVED, RECEIVED, CLOSED, CANCELLED
    }

    @Id
    private UUID id;

    @Column(name = "po_number", nullable = false, unique = true, length = 32)
    private String number;

    @Column(name = "vendor_id", nullable = false)
    private UUID vendorId;

    @Column(name = "cost_center_code", nullable = false, length = 16)
    private String costCenterCode;

    @Column(nullable = false, length = 3)
    private String currency;

    @Column(nullable = false, precision = 18, scale = 2)
    private BigDecimal total;

    @Column(name = "received_value", nullable = false, precision = 18, scale = 2)
    private BigDecimal receivedValue = BigDecimal.ZERO;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 24)
    private Status status = Status.DRAFT;

    @Column(name = "requested_by", nullable = false, length = 128)
    private String requestedBy;

    @Column(name = "approval_request_id")
    private UUID approvalRequestId;

    @Column(name = "expected_on")
    private LocalDate expectedOn;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Version
    private long version;

    protected PurchaseOrder() {
    }

    public static PurchaseOrder draft(String number, UUID vendorId, String costCenterCode, String currency,
                                      BigDecimal total, String requestedBy, LocalDate expectedOn, Instant now) {
        PurchaseOrder order = new PurchaseOrder();
        order.id = UUID.randomUUID();
        order.number = number;
        order.vendorId = vendorId;
        order.costCenterCode = costCenterCode;
        order.currency = currency;
        order.total = total;
        order.requestedBy = requestedBy;
        order.expectedOn = expectedOn;
        order.createdAt = now;
        return order;
    }

    public void markPendingApproval(UUID requestId) {
        require(Status.DRAFT);
        approvalRequestId = requestId;
        status = Status.PENDING_APPROVAL;
    }

    public void markApproved() {
        require(Status.PENDING_APPROVAL);
        status = Status.APPROVED;
    }

    public void markOrdered() {
        require(Status.APPROVED);
        status = Status.ORDERED;
    }

    public void cancel() {
        // Cancelling after goods arrived is a returns process, and returns are not this module's problem.
        require(Status.DRAFT, Status.PENDING_APPROVAL, Status.APPROVED, Status.ORDERED);
        status = Status.CANCELLED;
    }

    public void receive(BigDecimal value) {
        require(Status.ORDERED, Status.PARTIALLY_RECEIVED);
        if (value == null || value.signum() <= 0) {
            throw new WorkflowViolationException("received value must be positive on " + number);
        }
        receivedValue = receivedValue.add(value);
        status = receivedValue.compareTo(total) >= 0 ? Status.RECEIVED : Status.PARTIALLY_RECEIVED;
    }

    public void close() {
        require(Status.RECEIVED, Status.CANCELLED);
        status = Status.CLOSED;
    }

    public BigDecimal outstandingValue() {
        return total.subtract(receivedValue).max(BigDecimal.ZERO);
    }

    private void require(Status... allowed) {
        for (Status s : allowed) {
            if (s == status) {
                return;
            }
        }
        throw new WorkflowViolationException("purchase order " + number + " is " + status);
    }

    public UUID getId() { return id; }
    public String getNumber() { return number; }
    public UUID getVendorId() { return vendorId; }
    public String getCostCenterCode() { return costCenterCode; }
    public String getCurrency() { return currency; }
    public BigDecimal getTotal() { return total; }
    public BigDecimal getReceivedValue() { return receivedValue; }
    public Status getStatus() { return status; }
    public String getRequestedBy() { return requestedBy; }
    public UUID getApprovalRequestId() { return approvalRequestId; }
    public LocalDate getExpectedOn() { return expectedOn; }
    public Instant getCreatedAt() { return createdAt; }
}
`;

/* ------------------------------------------------------------------ */
/* common / config / audit / application                               */
/* ------------------------------------------------------------------ */

SRC.EXCEPTION_HANDLER = `package com.erp.core.common;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;

/**
 * Turns exceptions into RFC 9457 problem documents. The frontend shows the
 * "detail" field verbatim, so every message here is one a controller would
 * be comfortable reading out loud in a steering meeting.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);
    private static final URI PROBLEM_BASE = URI.create("https://erp.internal.corp/problems/");

    @ExceptionHandler(NotFoundException.class)
    public ProblemDetail notFound(NotFoundException ex) {
        return problem(HttpStatus.NOT_FOUND, "not-found", ex.getMessage());
    }

    @ExceptionHandler(WorkflowViolationException.class)
    public ProblemDetail workflowViolation(WorkflowViolationException ex) {
        // 409, not 400: the request was well-formed, the universe simply disagreed with it.
        return problem(HttpStatus.CONFLICT, "workflow-violation", ex.getMessage());
    }

    @ExceptionHandler(OptimisticLockingFailureException.class)
    public ProblemDetail staleVersion(OptimisticLockingFailureException ex) {
        return problem(HttpStatus.CONFLICT, "stale-version",
                "the record changed while you were looking at it; reload and try again");
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ProblemDetail invalid(MethodArgumentNotValidException ex) {
        List<Map<String, String>> violations = ex.getBindingResult().getFieldErrors().stream()
                .map(f -> Map.of("field", f.getField(), "message", String.valueOf(f.getDefaultMessage())))
                .toList();
        ProblemDetail pd = problem(HttpStatus.BAD_REQUEST, "validation", "request body failed validation");
        pd.setProperty("violations", violations);
        return pd;
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ProblemDetail forbidden(AccessDeniedException ex) {
        return problem(HttpStatus.FORBIDDEN, "forbidden", "you are not an approver for this request");
    }

    @ExceptionHandler(Exception.class)
    public ProblemDetail unexpected(Exception ex, WebRequest request) {
        String incidentId = UUID.randomUUID().toString();
        log.error("unhandled exception {} for {}", incidentId, request.getDescription(false), ex);
        ProblemDetail pd = problem(HttpStatus.INTERNAL_SERVER_ERROR, "internal",
                "something went wrong; quote the incident id when you ask about it");
        pd.setProperty("incidentId", incidentId);
        return pd;
    }

    private static ProblemDetail problem(HttpStatus status, String type, String detail) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setType(PROBLEM_BASE.resolve(type));
        pd.setTitle(status.getReasonPhrase());
        pd.setProperty("timestamp", Instant.now());
        return pd;
    }
}
`;

SRC.SECURITY_CONFIG = `package com.erp.core.config;

import java.util.Collection;
import java.util.List;
import java.util.stream.Collectors;

import org.springframework.boot.actuate.autoconfigure.security.servlet.EndpointRequest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.web.SecurityFilterChain;

/**
 * ERP-4439: the API is a stateless OAuth2 resource server; roles come from the
 * "erp_roles" claim issued by the corporate SSO. Actuator lives on 8081 and
 * only health/prometheus are reachable without a token, because the probes
 * do not carry one and Kubernetes does not negotiate.
 */
@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    private static final String ROLE_CLAIM = "erp_roles";
    private static final String ROLE_PREFIX = "ROLE_";

    @Bean
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(EndpointRequest.to("health", "prometheus")).permitAll()
                .requestMatchers(EndpointRequest.toAnyEndpoint()).hasRole("PLATFORM")
                .requestMatchers("/api/v1/**").authenticated()
                .anyRequest().denyAll())
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtConverter())));
        return http.build();
    }

    @Bean
    Converter<Jwt, AbstractAuthenticationToken> jwtConverter() {
        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setPrincipalClaimName("preferred_username");
        converter.setJwtGrantedAuthoritiesConverter(SecurityConfig::authoritiesFrom);
        return converter;
    }

    private static Collection<GrantedAuthority> authoritiesFrom(Jwt jwt) {
        List<String> roles = jwt.getClaimAsStringList(ROLE_CLAIM);
        if (roles == null || roles.isEmpty()) {
            // A token with no roles is a valid token that can do nothing. Much like a visitor badge.
            return List.of();
        }
        return roles.stream()
                .map(String::toUpperCase)
                .map(role -> role.startsWith(ROLE_PREFIX) ? role : ROLE_PREFIX + role)
                .map(SimpleGrantedAuthority::new)
                .collect(Collectors.toUnmodifiableList());
    }
}
`;

SRC.AUDIT_ASPECT = `package com.erp.core.audit;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.stream.Collectors;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.reflect.MethodSignature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * ERP-4455: every method annotated with {@link Audited} leaves a row in
 * erp.audit_event, whether it succeeded or not. Especially if not.
 *
 * Ordered after the transaction interceptor so a successful event is written
 * inside the same transaction as the change it describes.
 */
@Aspect
@Component
@Order(10)
public class AuditAspect {

    private static final Logger log = LoggerFactory.getLogger(AuditAspect.class);
    private static final int MAX_ARG_LENGTH = 200;
    private static final String SYSTEM_ACTOR = "system";

    private final AuditEventRepository events;
    private final Clock clock;

    public AuditAspect(AuditEventRepository events, Clock clock) {
        this.events = events;
        this.clock = clock;
    }

    @Around("@annotation(audited)")
    public Object around(ProceedingJoinPoint pjp, Audited audited) throws Throwable {
        Instant started = clock.instant();
        MethodSignature signature = (MethodSignature) pjp.getSignature();
        String target = signature.getDeclaringType().getSimpleName() + "." + signature.getName();
        String actor = currentActor();
        String args = summarize(pjp.getArgs());

        try {
            Object result = pjp.proceed();
            record(audited.action(), actor, target, args, AuditEvent.Outcome.SUCCESS, null, started);
            return result;
        } catch (RuntimeException ex) {
            record(audited.action(), actor, target, args, AuditEvent.Outcome.FAILURE, ex.getMessage(), started);
            throw ex;
        }
    }

    private void record(String action, String actor, String target, String args,
                        AuditEvent.Outcome outcome, String detail, Instant started) {
        Duration took = Duration.between(started, clock.instant());
        if (outcome == AuditEvent.Outcome.FAILURE && TransactionSynchronizationManager.isActualTransactionActive()) {
            // The surrounding transaction is about to roll back and take our row with it.
            // Log it instead; the log shipper does not believe in transactions.
            log.warn("audit {} {} by {} failed after {} ms: {}", action, target, actor, took.toMillis(), detail);
            return;
        }
        events.save(new AuditEvent(action, actor, target, args, outcome, detail, started, took));
        log.debug("audit {} {} by {} {} in {} ms", action, target, actor, outcome, took.toMillis());
    }

    private static String currentActor() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated() || auth.getName() == null) {
            return SYSTEM_ACTOR;
        }
        return auth.getName();
    }

    private static String summarize(Object[] args) {
        String joined = Arrays.stream(args).map(AuditAspect::render).collect(Collectors.joining(", "));
        return joined.length() <= MAX_ARG_LENGTH ? joined : joined.substring(0, MAX_ARG_LENGTH) + "...";
    }

    private static String render(Object arg) {
        if (arg == null) {
            return "null";
        }
        if (arg instanceof CharSequence || arg instanceof Number || arg instanceof java.util.UUID) {
            return "'" + arg + "'";
        }
        // Entities render as type#identity. Their contents are in the table already; that is the point.
        return arg.getClass().getSimpleName() + "#" + Integer.toHexString(System.identityHashCode(arg));
    }
}
`;

SRC.APPLICATION = `package com.erp.core;

import java.time.Clock;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.context.annotation.Bean;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * erp-core: purchase orders, invoices, approvals, audit.
 * Everything else in the ERP is a client of this module and will tell you so.
 */
@SpringBootApplication
@EnableJpaAuditing
@EnableAsync
@EnableScheduling
@ConfigurationPropertiesScan
public class ErpCoreApplication {

    public static void main(String[] args) {
        SpringApplication.run(ErpCoreApplication.class, args);
    }

    /**
     * Injected everywhere a timestamp is produced so tests can freeze time.
     * Production runs on UTC; the finance team runs on quarter-end.
     */
    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
`;

/* ------------------------------------------------------------------ */
/* resources                                                           */
/* ------------------------------------------------------------------ */

SRC.APPLICATION_YML = `spring:
  application:
    name: erp-core
  datasource:
    url: jdbc:postgresql://localhost:5432/erp
    username: erp
    password: localdev
    hikari:
      pool-name: erp-core-hikari
      maximum-pool-size: 16
      minimum-idle: 2
      connection-timeout: 3000
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
    properties:
      hibernate:
        default_schema: erp
        jdbc.time_zone: UTC
        jdbc.batch_size: 50
        order_inserts: true
        order_updates: true
  flyway:
    enabled: true
    schemas: erp
    locations: classpath:db/migration
    baseline-on-migrate: false
    validate-on-migrate: true
    out-of-order: false
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://sso.internal.corp/realms/erp
          audiences: erp-core
  jackson:
    default-property-inclusion: non_null
    serialization:
      write-dates-as-timestamps: false

server:
  port: 8080
  shutdown: graceful
  error:
    include-stacktrace: never
    include-message: never

management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,flyway
  endpoint:
    health:
      show-details: when-authorized
      probes:
        enabled: true
  metrics:
    tags:
      application: erp-core

erp:
  approval:
    finance-threshold: 10000.00
    cfo-threshold: 250000.00
    step-sla: PT48H
    # every 15 minutes; the escalation job is idempotent and, unlike its recipients, patient
    escalation-cron: "0 */15 * * * *"
  invoice:
    match-tolerance: 0.02
  notifier:
    base-url: https://erp.internal.corp/approvals
    from: erp-noreply@internal.corp

logging:
  level:
    com.erp.core: DEBUG
    org.hibernate.SQL: DEBUG
    org.springframework.security: INFO
`;

SRC.APPLICATION_PROD_YML = `# Profile: prod (and staging, which is prod with a different database and lower stakes).
# Secrets arrive from the vault sidecar as environment variables at pod start.
# Do not put real values here. Do not put fake values here either. We have been burned.
spring:
  datasource:
    url: jdbc:postgresql://erp-staging:5432/erp
    username: erp_app
    password: changeme-injected-by-vault-sidecar
    hikari:
      maximum-pool-size: 32
      connection-timeout: 5000
      leak-detection-threshold: 20000
  jpa:
    show-sql: false
  flyway:
    # migrations run from the CI job (see .gitlab-ci.yml), never from the pod
    enabled: false
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://sso.internal.corp/realms/erp

server:
  tomcat:
    threads:
      max: 200
    accept-count: 100

management:
  endpoint:
    health:
      show-details: never
  tracing:
    sampling:
      probability: 0.1
  otlp:
    tracing:
      endpoint: http://otel-collector.observability.svc:4318/v1/traces

erp:
  approval:
    escalation-cron: "0 0 7,13 * * MON-FRI"

logging:
  level:
    com.erp.core: INFO
    org.hibernate.SQL: WARN
`;

SRC.LOGBACK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- erp-core logging. Humans get one line per event; machines get JSON. Neither gets stack traces twice. -->
<configuration scan="true" scanPeriod="30 seconds">
    <include resource="org/springframework/boot/logging/logback/defaults.xml"/>

    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{HH:mm:ss.SSS} %-5level [%15.15thread] %-40.40logger{39} : %msg%n</pattern>
            <charset>UTF-8</charset>
        </encoder>
    </appender>

    <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="net.logstash.logback.encoder.LogstashEncoder">
            <customFields>{"service":"erp-core","team":"erp-platform"}</customFields>
            <includeMdcKeyName>traceId</includeMdcKeyName>
            <includeMdcKeyName>spanId</includeMdcKeyName>
            <includeMdcKeyName>actor</includeMdcKeyName>
            <shortenedLoggerNameLength>36</shortenedLoggerNameLength>
        </encoder>
    </appender>

    <springProfile name="local | test">
        <root level="INFO">
            <appender-ref ref="CONSOLE"/>
        </root>
        <logger name="com.erp.core" level="DEBUG"/>
        <logger name="org.hibernate.orm.jdbc.bind" level="TRACE"/>
    </springProfile>

    <springProfile name="staging | prod">
        <root level="INFO">
            <appender-ref ref="JSON"/>
        </root>
        <logger name="com.erp.core.audit" level="INFO"/>
        <!-- the health probe logs once per second; nobody has ever read one of those lines -->
        <logger name="org.springframework.boot.actuate.health" level="WARN"/>
    </springProfile>
</configuration>
`;

SRC.POM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.3.4</version>
        <relativePath/>
    </parent>

    <groupId>com.erp</groupId>
    <artifactId>erp-core</artifactId>
    <version>2.14.0</version>
    <packaging>jar</packaging>
    <name>erp-core</name>
    <description>Core ERP module: purchase orders, invoices, approval workflow, audit trail</description>

    <properties>
        <java.version>21</java.version>
        <maven.compiler.release>21</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-jpa</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-validation</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-security</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-oauth2-resource-server</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-aop</artifactId>
        </dependency>
        <dependency>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-core</artifactId>
        </dependency>
        <dependency>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-database-postgresql</artifactId>
        </dependency>
        <dependency>
            <groupId>org.postgresql</groupId>
            <artifactId>postgresql</artifactId>
            <scope>runtime</scope>
        </dependency>
        <dependency>
            <groupId>io.micrometer</groupId>
            <artifactId>micrometer-registry-prometheus</artifactId>
            <scope>runtime</scope>
        </dependency>
        <dependency>
            <groupId>net.logstash.logback</groupId>
            <artifactId>logstash-logback-encoder</artifactId>
            <version>8.0</version>
        </dependency>

        <!-- test -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
        <dependency>
            <groupId>org.springframework.security</groupId>
            <artifactId>spring-security-test</artifactId>
            <scope>test</scope>
        </dependency>
        <dependency>
            <groupId>org.testcontainers</groupId>
            <artifactId>postgresql</artifactId>
            <scope>test</scope>
        </dependency>
        <dependency>
            <groupId>org.testcontainers</groupId>
            <artifactId>junit-jupiter</artifactId>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <executions>
                    <execution>
                        <goals>
                            <goal>build-info</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>
            <plugin>
                <!-- ERP-4471 depends on this being green. So does everything else, but ERP-4471 asked nicely. -->
                <groupId>com.diffplug.spotless</groupId>
                <artifactId>spotless-maven-plugin</artifactId>
                <version>2.43.0</version>
                <configuration>
                    <java>
                        <googleJavaFormat>
                            <version>1.23.0</version>
                            <style>AOSP</style>
                        </googleJavaFormat>
                        <removeUnusedImports/>
                        <importOrder>
                            <order>java,jakarta,org,com</order>
                        </importOrder>
                    </java>
                </configuration>
                <executions>
                    <execution>
                        <phase>verify</phase>
                        <goals>
                            <goal>check</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>
            <plugin>
                <groupId>org.flywaydb</groupId>
                <artifactId>flyway-maven-plugin</artifactId>
                <configuration>
                    <url>jdbc:postgresql://localhost:5432/erp</url>
                    <user>erp</user>
                    <password>localdev</password>
                    <schemas>
                        <schema>erp</schema>
                    </schemas>
                    <locations>
                        <location>filesystem:src/main/resources/db/migration</location>
                    </locations>
                </configuration>
            </plugin>
            <plugin>
                <groupId>org.jacoco</groupId>
                <artifactId>jacoco-maven-plugin</artifactId>
                <version>0.8.12</version>
                <executions>
                    <execution>
                        <goals>
                            <goal>prepare-agent</goal>
                        </goals>
                    </execution>
                    <execution>
                        <id>report</id>
                        <phase>test</phase>
                        <goals>
                            <goal>report</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>
        </plugins>
    </build>

    <repositories>
        <repository>
            <id>internal</id>
            <url>https://nexus.internal.corp/repository/maven-public/</url>
        </repository>
    </repositories>
</project>
`;

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

SRC.WORKFLOW_TEST = `package com.erp.core.approval;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.erp.core.approval.ApprovalRequest.SubjectType;
import com.erp.core.audit.AuditEventPublisher;
import com.erp.core.common.WorkflowViolationException;
import com.erp.core.notify.ApproverNotifier;

@ExtendWith(MockitoExtension.class)
class ApprovalWorkflowServiceTest {

    private static final Instant NOW = Instant.parse("2026-09-07T09:00:00Z");

    @Mock ApprovalRepository repository;
    @Mock AuditEventPublisher audit;
    @Mock ApproverNotifier notifier;

    private ApprovalWorkflowService service;

    @BeforeEach
    void setUp() {
        service = new ApprovalWorkflowService(repository, audit, notifier, Clock.fixed(NOW, ZoneOffset.UTC));
        lenient().when(repository.save(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    private ApprovalRequest draft(String amount) {
        ApprovalRequest request = ApprovalRequest.draft(
                SubjectType.PURCHASE_ORDER, UUID.randomUUID(), "CC-4100", new BigDecimal(amount), "EUR");
        lenient().when(repository.findWithLockById(request.getId())).thenReturn(Optional.of(request));
        return request;
    }

    private ApprovalRequest submitted(String amount) {
        ApprovalRequest request = draft(amount);
        service.submit(request.getId(), "i.ferreira");
        return request;
    }

    @Nested
    @DisplayName("submit")
    class Submit {

        @Test
        void plansASingleStepBelowTheFinanceThreshold() {
            ApprovalRequest request = submitted("9999.99");

            assertThat(request.getState()).isEqualTo(ApprovalState.PENDING);
            assertThat(request.getSteps()).extracting(ApprovalStep::getRole).containsExactly("COST_CENTER_OWNER");
            assertThat(request.getCurrentStep()).isEqualTo(1);
            verify(notifier).notifyPending(eq(request), any());
        }

        @Test
        void addsAFinanceStepAtTheThreshold() {
            ApprovalRequest request = submitted("10000.00");

            assertThat(request.getSteps()).extracting(ApprovalStep::getRole)
                    .containsExactly("COST_CENTER_OWNER", "FINANCE_CONTROLLER");
        }

        @Test
        void addsTheCfoForLargeAmounts() {
            ApprovalRequest request = submitted("250000.00");

            assertThat(request.getSteps()).hasSize(3);
            assertThat(request.getSteps().get(2).getScope()).isEqualTo("GLOBAL");
        }

        @Test
        void refusesToSubmitTwice() {
            ApprovalRequest request = submitted("500.00");

            assertThatThrownBy(() -> service.submit(request.getId(), "i.ferreira"))
                    .isInstanceOf(WorkflowViolationException.class)
                    .hasMessageContaining("illegal transition PENDING -> PENDING");
        }
    }

    @Nested
    @DisplayName("approve")
    class Approve {

        @Test
        void advancesToTheNextStep() {
            ApprovalRequest request = submitted("48250.00");

            service.approve(request.getId(), "h.brandt", "looks fine");

            assertThat(request.getState()).isEqualTo(ApprovalState.PENDING);
            assertThat(request.getCurrentStep()).isEqualTo(2);
            assertThat(request.getSteps().get(0).getDecidedBy()).isEqualTo("h.brandt");
            verify(notifier, never()).notifyCompleted(any());
        }

        @Test
        void completesOnTheFinalStep() {
            ApprovalRequest request = submitted("48250.00");
            service.approve(request.getId(), "h.brandt", null);

            service.approve(request.getId(), "p.raman", "budget confirmed");

            assertThat(request.getState()).isEqualTo(ApprovalState.APPROVED);
            assertThat(request.getDecidedAt()).isEqualTo(NOW);
            verify(notifier).notifyCompleted(request);
            verify(audit).transition(request, ApprovalState.PENDING, ApprovalState.APPROVED, "p.raman");
        }

        @Test
        void rejectsADraftThatWasNeverSubmitted() {
            ApprovalRequest request = draft("100.00");

            assertThatThrownBy(() -> service.approve(request.getId(), "h.brandt", null))
                    .isInstanceOf(WorkflowViolationException.class)
                    .hasMessageContaining("is DRAFT");
        }

        @Test
        void rejectsAnUnknownRequest() {
            UUID missing = UUID.randomUUID();

            assertThatThrownBy(() -> service.approve(missing, "h.brandt", null))
                    .isInstanceOf(WorkflowViolationException.class)
                    .hasMessageContaining(missing.toString());
        }
    }

    @Nested
    @DisplayName("reject")
    class Reject {

        @Test
        void requiresAReason() {
            ApprovalRequest request = submitted("500.00");

            assertThatThrownBy(() -> service.reject(request.getId(), "h.brandt", "  "))
                    .isInstanceOf(WorkflowViolationException.class);
            verify(notifier, never()).notifyRejected(any(), anyString());
        }

        @Test
        void marksTheRequestRejectedAndNotifies() {
            ApprovalRequest request = submitted("500.00");

            service.reject(request.getId(), "h.brandt", "wrong cost center");

            assertThat(request.getState()).isEqualTo(ApprovalState.REJECTED);
            assertThat(request.getSteps().get(0).getComment()).isEqualTo("wrong cost center");
            verify(notifier).notifyRejected(request, "wrong cost center");
        }

        @Test
        void aRejectedRequestCannotBeApproved() {
            ApprovalRequest request = submitted("500.00");
            service.reject(request.getId(), "h.brandt", "duplicate of PO-2026-000790");

            // The second opinion arrives late and is not entertained.
            assertThatThrownBy(() -> service.approve(request.getId(), "p.raman", "actually fine"))
                    .isInstanceOf(WorkflowViolationException.class)
                    .hasMessageContaining("is REJECTED");
        }
    }
}
`;

SRC.INVOICE_TEST = `package com.erp.core.invoice;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.erp.core.approval.ApprovalRepository;
import com.erp.core.approval.ApprovalWorkflowService;
import com.erp.core.common.NotFoundException;
import com.erp.core.common.WorkflowViolationException;
import com.erp.core.invoice.InvoiceService.RegisterInvoiceCommand;
import com.erp.core.procurement.PurchaseOrder;
import com.erp.core.procurement.PurchaseOrderRepository;

@ExtendWith(MockitoExtension.class)
class InvoiceServiceTest {

    private static final Instant NOW = Instant.parse("2026-09-07T09:00:00Z");

    @Mock InvoiceRepository invoices;
    @Mock PurchaseOrderRepository purchaseOrders;
    @Mock ApprovalRepository approvals;
    @Mock ApprovalWorkflowService workflow;

    private InvoiceService service;
    private PurchaseOrder order;

    @BeforeEach
    void setUp() {
        service = new InvoiceService(invoices, purchaseOrders, approvals, workflow, Clock.fixed(NOW, ZoneOffset.UTC));
        order = PurchaseOrder.draft("PO-2026-000813", UUID.randomUUID(), "CC-4100", "EUR",
                new BigDecimal("1200.00"), "i.ferreira", LocalDate.of(2026, 9, 30), NOW);
        lenient().when(purchaseOrders.findById(order.getId())).thenReturn(Optional.of(order));
        lenient().when(invoices.save(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    private RegisterInvoiceCommand command(String total, String currency) {
        return new RegisterInvoiceCommand(order.getVendorId(), order.getId(), "INV-77145",
                currency, new BigDecimal(total), LocalDate.of(2026, 9, 5));
    }

    @Test
    void autoMatchesWithinTolerance() {
        Invoice invoice = service.register(command("1218.00", "EUR"), "t.nowak");

        assertThat(invoice.getStatus()).isEqualTo(Invoice.Status.MATCHED);
        assertThat(invoice.getMatchedAt()).isEqualTo(NOW);
        verify(workflow, never()).submit(any(), anyString());
    }

    @Test
    void opensAnApprovalAboveTolerance() {
        Invoice invoice = service.register(command("1350.00", "EUR"), "t.nowak");

        assertThat(invoice.getStatus()).isEqualTo(Invoice.Status.PENDING_APPROVAL);
        assertThat(invoice.getApprovalRequestId()).isNotNull();
        verify(approvals).save(any());
        verify(workflow).submit(invoice.getApprovalRequestId(), "t.nowak");
    }

    @Test
    void matchesAgainstReceivedValueOnceGoodsArrived() {
        order.markPendingApproval(UUID.randomUUID());
        order.markApproved();
        order.markOrdered();
        order.receive(new BigDecimal("600.00"));

        Invoice invoice = service.register(command("605.00", "EUR"), "t.nowak");

        // Half the goods, half the money. The vendor and the warehouse agree for once.
        assertThat(invoice.getStatus()).isEqualTo(Invoice.Status.MATCHED);
    }

    @Test
    void rejectsADuplicateInvoiceNumber() {
        when(invoices.existsByVendorIdAndInvoiceNumber(order.getVendorId(), "INV-77145")).thenReturn(true);

        assertThatThrownBy(() -> service.register(command("1200.00", "EUR"), "t.nowak"))
                .isInstanceOf(WorkflowViolationException.class)
                .hasMessageContaining("already registered");
        verify(invoices, never()).save(any());
    }

    @Test
    void rejectsAnUnknownPurchaseOrder() {
        RegisterInvoiceCommand orphan = new RegisterInvoiceCommand(order.getVendorId(), UUID.randomUUID(),
                "INV-77146", "EUR", new BigDecimal("10.00"), LocalDate.of(2026, 9, 5));

        assertThatThrownBy(() -> service.register(orphan, "t.nowak"))
                .isInstanceOf(NotFoundException.class);
    }

    @Test
    void rejectsACurrencyMismatch() {
        assertThatThrownBy(() -> service.register(command("1200.00", "USD"), "t.nowak"))
                .isInstanceOf(WorkflowViolationException.class)
                .hasMessageContaining("USD");
    }

    @Test
    void reportsVarianceRelativeToTheReference() {
        Invoice invoice = Invoice.from(command("1500.00", "EUR"), order, NOW);

        InvoiceService.MatchResult result = service.threeWayMatch(invoice, order);

        assertThat(result.difference()).isEqualByComparingTo("300.00");
        assertThat(result.variance()).isEqualByComparingTo("0.25");
        assertThat(result.withinTolerance()).isFalse();
    }
}
`;

/* ------------------------------------------------------------------ */
/* ops / docs                                                          */
/* ------------------------------------------------------------------ */

SRC.DOCKERFILE = `# syntax=docker/dockerfile:1.7
# erp-core: stage one downloads the internet, stage two ships 90 MB of it.
FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -q -B dependency:go-offline
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -q -B -DskipTests package

FROM eclipse-temurin:21-jre-jammy AS runtime
LABEL org.opencontainers.image.source="gitlab.internal.corp:erp/erp-core"
RUN useradd --system --uid 10001 --create-home erp
WORKDIR /app
COPY --from=build --chown=erp:erp /workspace/target/erp-core-*.jar /app/erp-core.jar
USER erp
EXPOSE 8080 8081
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+UseG1GC -Djava.security.egd=file:/dev/./urandom"
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s CMD curl -fsS http://localhost:8081/actuator/health/liveness || exit 1
ENTRYPOINT ["java", "-jar", "/app/erp-core.jar"]
`;

SRC.GITLAB_CI = `# erp-core pipeline. Stages run in the order listed; jobs within a stage run in
# parallel, which is why the runners are always busy and never fast.
stages:
  - build
  - test
  - quality
  - package
  - migrate
  - deploy

variables:
  MAVEN_OPTS: "-Dmaven.repo.local=.m2/repository -Dorg.slf4j.simpleLogger.showDateTime=true"
  MAVEN_CLI_OPTS: "--batch-mode --errors --fail-at-end --show-version"
  IMAGE: registry.internal.corp/erp/erp-core
  POSTGRES_DB: erp
  POSTGRES_USER: erp
  POSTGRES_PASSWORD: localdev

default:
  image: maven:3.9.9-eclipse-temurin-21
  cache:
    key: maven-erp-core
    paths:
      - .m2/repository

build:
  stage: build
  script:
    - mvn $MAVEN_CLI_OPTS -DskipTests compile
  artifacts:
    paths:
      - target/classes
    expire_in: 2 hours

unit-tests:
  stage: test
  services:
    - name: postgres:16-alpine
      alias: postgres
  script:
    - mvn $MAVEN_CLI_OPTS verify
  artifacts:
    when: always
    reports:
      junit: target/surefire-reports/TEST-*.xml
    paths:
      - target/site/jacoco

spotless:
  stage: quality
  script:
    - mvn $MAVEN_CLI_OPTS spotless:check

flyway-validate:
  stage: quality
  services:
    - name: postgres:16-alpine
      alias: postgres
  script:
    - mvn $MAVEN_CLI_OPTS -Dflyway.url=jdbc:postgresql://postgres:5432/erp -Dflyway.user=erp -Dflyway.password=localdev flyway:migrate flyway:validate

package:
  stage: package
  image:
    name: gcr.io/kaniko-project/executor:v1.23.2-debug
    entrypoint: [""]
  script:
    - /kaniko/executor --context $CI_PROJECT_DIR --dockerfile $CI_PROJECT_DIR/Dockerfile --destination $IMAGE:$CI_COMMIT_SHORT_SHA --destination $IMAGE:$CI_COMMIT_REF_SLUG
  rules:
    - if: $CI_COMMIT_BRANCH == "main" || $CI_COMMIT_BRANCH == "develop"
    - if: $CI_COMMIT_BRANCH =~ /^release/
    - if: $CI_COMMIT_BRANCH =~ /^feature/

migrate-staging:
  stage: migrate
  environment:
    name: erp-staging
  script:
    # runs before deploy so the pod finds V23 and V24 already applied
    - mvn $MAVEN_CLI_OPTS -Dflyway.url=jdbc:postgresql://erp-staging:5432/erp -Dflyway.user=erp_migrator -Dflyway.password=$FLYWAY_PASSWORD_STAGING flyway:migrate
  rules:
    - if: $CI_COMMIT_BRANCH == "develop"

deploy-staging:
  stage: deploy
  image: registry.internal.corp/platform/kubectl:1.30
  environment:
    name: erp-staging
    url: https://erp-staging.internal.corp
  script:
    - kubectl -n erp-staging set image deployment/erp-core erp-core=$IMAGE:$CI_COMMIT_SHORT_SHA
    - kubectl -n erp-staging rollout status deployment/erp-core --timeout=180s
  rules:
    - if: $CI_COMMIT_BRANCH == "develop"
`;

SRC.ADR_0007 = `# ADR-0007: Approval workflow as an explicit state machine

- Status: Accepted
- Date: 2026-08-28
- Ticket: ERP-4471
- Deciders: erp-platform team, finance systems lead, internal audit (observer)

## Context

Purchase orders and invoices above certain amounts must be approved by one to
three people before they are booked. The previous implementation (ERP-2210,
"approval flag on the PO") stored a single boolean and a free-text column called
approved_by_note. Internal audit reviewed it in Q2 and used the word "creative"
twice in one paragraph.

Requirements gathered from finance, procurement and audit:

1. Multiple sequential steps, planned at submission time from amount and cost center.
2. Every decision is attributable to a person and a timestamp and cannot be edited afterwards.
3. Overdue steps are escalated automatically. Nobody wants to be the reminder.
4. The same engine serves purchase orders and invoices (three-way match variances, ERP-4462).

## Decision

Model the workflow as an explicit state machine on an ApprovalRequest aggregate
with a fixed, ordered list of ApprovalStep rows. The aggregate owns every
transition; services orchestrate, entities decide.

States: DRAFT, PENDING, ESCALATED, APPROVED, REJECTED, CANCELLED.

| From      | To                              | Trigger                                  |
|-----------|---------------------------------|------------------------------------------|
| DRAFT     | PENDING                         | submit()                                 |
| DRAFT     | CANCELLED                       | requester withdraws                      |
| PENDING   | PENDING                         | approve() with steps remaining           |
| PENDING   | APPROVED                        | approve() on the final step              |
| PENDING   | REJECTED                        | reject()                                 |
| PENDING   | ESCALATED                       | escalation job, current step past SLA    |
| PENDING   | CANCELLED                       | requester withdraws                      |
| ESCALATED | APPROVED, REJECTED, CANCELLED   | as PENDING, decided by the escalation role |
| REJECTED  | DRAFT                           | requester edits and resubmits            |

The table lives in code (ApprovalState.TRANSITIONS). This document is a copy and
will drift. When they disagree, the code is right and this document is scheduled
for an update that will not happen.

Steps are planned once, at submission, from the amount:

- always: COST_CENTER_OWNER for the request's cost center
- at or above 10,000: FINANCE_CONTROLLER
- at or above 250,000: CFO (scope GLOBAL)

Thresholds are configuration, not code, so finance can move them without a
release. They have not moved them. They asked for the feature in writing.

## Alternatives considered

- A BPMN engine. Evaluated for three weeks. It would have been a fine choice
  for a company with a BPMN team, which is a different company.
- Keeping the boolean and adding a second boolean. Rejected by audit, in writing,
  with a reference number.
- Event sourcing the whole aggregate. Attractive, and the team would have
  learned a lot, which is the problem.

## Consequences

- Two new tables (approval_request, approval_step) plus indexes in V23 and V24.
- Every decision is a row with an actor, a timestamp and a pessimistic lock
  around it. Concurrent approvals serialize instead of racing.
- Audit gets a query they can run themselves and a dashboard they will not use.
- The escalation job needs the SLA per step; the default is 48 hours and
  lives in application.yml under erp.approval.step-sla.
- Rejected requests go back to DRAFT rather than being cloned. Requesters
  asked for this; audit accepted it on the condition that the rejected step's
  row is never deleted. It is not. Nothing here is ever deleted.
`;

SRC.README = `# erp-core

Core module of the internal ERP: purchase orders, invoices, multi-step approvals
and the audit trail that makes all three defensible.

## Stack

- Java 21, Spring Boot 3.3, Spring Data JPA, Spring Security (OAuth2 resource server)
- PostgreSQL 16, Flyway migrations under src/main/resources/db/migration
- Maven, Spotless (google-java-format, AOSP style), JaCoCo
- Runs in erp-staging and erp-prod as one Deployment behind the corporate SSO

## Running locally

1. Start a database: docker compose -f ops/local/compose.yml up -d postgres
2. Apply migrations: mvn flyway:migrate
3. Run the app: mvn spring-boot:run -Dspring-boot.run.profiles=local
4. API on 8080, actuator on 8081, JDWP debugger on 5005

Tokens for local calls come from https://sso.internal.corp/realms/erp (client erp-local).
Ask in #erp-platform if your account has no erp_roles claim. It happens to everyone once.

## Packages

| package     | owns                                                       |
|-------------|------------------------------------------------------------|
| approval    | ApprovalRequest aggregate, state machine, REST endpoints   |
| invoice     | invoice registration and the three-way match (ERP-4462)    |
| procurement | purchase orders and goods receipt                          |
| audit       | the @Audited aspect and the audit_event table (ERP-4455)   |
| common      | problem-detail error handling                              |
| config      | security, clock, everything Spring needs told twice        |

## Conventions

- Every state change is a method on the aggregate. No setters. Yes, we know about the mapper.
- Migrations are append-only. V23 and V24 belong to ERP-4471; do not edit them once merged.
- Branches: feature/ERP-ticket-slug. Commits: conventional, scope = package name.
- Nothing in erp schema is ever deleted. Audit was very clear, and very calm, about this.

See docs/adr for the decisions that hurt the most, starting with ADR-0007.
`;

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

PROFILES.register({
  id: 'enterprise',
  label: 'Enterprise Java',
  stack: 'Spring Boot · JPA · Maven',
  desc: 'Core ERP module: purchase orders, invoices and a multi-step approval workflow with audit trail and Flyway migrations.',
  project: 'erp-core',
  version: '2.14.0',
  branch: 'feature/ERP-4471-approval-workflow',
  remote: 'gitlab.internal.corp:erp/erp-core',
  image: 'registry.internal.corp/erp/erp-core',
  deployName: 'erp-core',
  namespace: 'erp-staging',
  dbLine: 'jdbc:postgresql://erp-staging:5432/erp',
  migrateLines: ['V23__approval_workflow', 'V24__approval_indexes'],
  primaryLang: 'java',
  checker: 'javac',
  checkFiles: 187,
  termproc: 'java — erp-core',
  hmrPath: null,
  shell: { user: 'dev', host: 'erp-dev-07', pkg: 'mvn' },
  ports: [
    [8080, 'erp-core', 'java'],
    [8081, 'actuator', 'java'],
    [5432, 'postgres', 'postgres'],
    [5005, 'JDWP debug', 'java'],
  ],
  scripts: [
    ['spring-boot:run', 'mvn spring-boot:run -Dspring-boot.run.profiles=local'],
    ['test', 'mvn -q test'],
    ['verify', 'mvn verify -Pintegration'],
    ['spotless:apply', 'mvn spotless:apply'],
    ['flyway:migrate', 'mvn flyway:migrate -Dflyway.configFiles=flyway-local.conf'],
    ['package', 'mvn -DskipTests package'],
  ],
  branches: [
    'main',
    'develop',
    'release/2026.09',
    'feature/ERP-4471-approval-workflow',
    'feature/ERP-4462-three-way-match',
    'hotfix/ERP-4439-actuator-auth',
  ],
  commits: [
    ['a7c3e91', 'feat(approval): ERP-4471 multi-step workflow state machine', 'Helga Brandt', '2 hours ago'],
    ['5d20f4b', 'feat(approval): ERP-4471 V23 migration for approval tables', 'Helga Brandt', '4 hours ago'],
    ['e19b7a0', 'fix(invoice): ERP-4462 match tolerance compared in the wrong currency', 'Tomasz Nowak', 'yesterday'],
    ['c88d1f2', 'chore(deps): bump spring-boot to 3.3.4', 'Priya Raman', 'yesterday'],
    ['0b6e4c7', 'feat(audit): ERP-4455 annotation-driven audit aspect', 'Marcus Oyelaran', '2 days ago'],
    ['f42a9d3', 'refactor(procurement): extract PurchaseOrderService from the controller', 'Ines Ferreira', '3 days ago'],
    ['91ce0b8', 'docs(adr): ADR-0007 approval state machine', 'Helga Brandt', '3 days ago'],
    ['3e7f5a6', 'ci: run flyway validate before packaging', 'Kenji Sato', '4 days ago'],
    ['b5d18e4', 'fix(security): ERP-4439 expose health without auth on 8081 only', 'Priya Raman', '5 days ago'],
    ['7a04c2d', 'test(invoice): cover the duplicate invoice number path', 'Tomasz Nowak', 'last week'],
  ],
  lintFiles: [
    ['src/main/java/com/erp/core/approval/ApprovalController.java', '93:44   Line is longer than 120 characters (found 123).', 'checkstyle:LineLength'],
    ['src/main/java/com/erp/core/invoice/InvoiceService.java', '103:5   Missing a Javadoc comment.', 'checkstyle:MissingJavadocMethod'],
    ['src/main/java/com/erp/core/audit/AuditAspect.java', '1:1     The file has formatting violations, run spotless:apply', 'spotless:java'],
    ['src/main/java/com/erp/core/procurement/PurchaseOrderService.java', '110:79  Magic number 30 should be a named constant.', 'checkstyle:MagicNumber'],
  ],
  suites: [
    ['src/test/java/com/erp/core/approval/ApprovalWorkflowServiceTest.java', 9, 12],
    ['src/test/java/com/erp/core/invoice/InvoiceServiceTest.java', 5, 8],
  ],
  jobs: ['mvn', 'junit', 'spotless', 'flyway', 'springboot', 'docker', 'k8s', 'gitfetch', 'migrate'],
  bootLines: [
    '<span class="mag">$</span> mvn spring-boot:run -Dspring-boot.run.profiles=local',
    '<span class="dim">[INFO] --- spring-boot:3.3.4:run (default-cli) @ erp-core ---</span>',
    '',
    '<span class="ok">  .   ____          _            __ _ _</span>',
    '<span class="ok"> /\\\\ / ___&#39;_ __ _ _(_)_ __  __ _ \\ \\ \\ \\</span>',
    '<span class="ok">( ( )\\___ | &#39;_ | &#39;_| | &#39;_ \\/ _&#39; | \\ \\ \\ \\</span>',
    '<span class="ok"> \\\\/  ___)| |_)| | | | | || (_| |  ) ) ) )</span>',
    '<span class="ok">  &#39;  |____| .__|_| |_|_| |_\\__, | / / / /</span>',
    '<span class="ok"> =========|_|==============|___/=/_/_/_/</span>',
    '<span class="dim"> :: Spring Boot ::                (v3.3.4)</span>',
    '',
    '<span class="dim">09:12:41.118</span>  <span class="ok">INFO</span> 48213 --- [           main] c.e.core.ErpCoreApplication              : Starting ErpCoreApplication v2.14.0 using Java 21.0.4 with PID 48213',
    '<span class="dim">09:12:41.121</span>  <span class="ok">INFO</span> 48213 --- [           main] c.e.core.ErpCoreApplication              : The following 1 profile is active: "local"',
    '<span class="dim">09:12:43.874</span>  <span class="ok">INFO</span> 48213 --- [           main] o.f.core.internal.command.DbMigrate      : Current version of schema "erp": 24',
    '<span class="dim">09:12:45.309</span>  <span class="ok">INFO</span> 48213 --- [           main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat started on port 8080 (http) with context path /',
  ],
  debug: {
    conf: 'Debug erp-core (JDWP :5005)',
    vars: [
      ['request.state', 'PENDING'],
      ['request.currentStep', '2'],
      ['request.amount', '48250.00'],
      ['step.role', '"FINANCE_CONTROLLER"'],
      ['approver', '"h.brandt"'],
    ],
    watch: [
      ['request.hasRemainingSteps()', 'false'],
      ['before.canTransitionTo(ApprovalState.APPROVED)', 'true'],
      ['clock.instant()', '2026-09-07T09:14:22.418Z'],
    ],
    stack: [
      'ApprovalWorkflowService.approve  ApprovalWorkflowService.java:74',
      'ApprovalWorkflowService$$SpringCGLIB$$0.approve  (proxy)',
      'AuditAspect.around  AuditAspect.java:54',
      'ApprovalController.approve  ApprovalController.java:72',
      'FrameworkServlet.service  FrameworkServlet.java:885',
    ],
  },
  files: () => [
    ['src/main/java/com/erp/core/approval/ApprovalWorkflowService.java', genLargeJavaClass(SRC.WORKFLOW_SERVICE, 'ApprovalWorkflowService', 'approval workflow', ['validateRequest', 'resolvePolicy', 'advanceStep', 'recordDecision', 'notifyApprovers', 'escalateOverdue', 'archiveRequest'], 1100), true],
    ['src/main/resources/db/migration/V23__approval_workflow.sql', genLargeSql(SRC.MIGRATION, 'erp', ['approval_request', 'approval_step', 'approval_policy', 'invoice', 'invoice_line', 'purchase_order', 'vendor', 'cost_center', 'audit_event'], 500), true],
    ['src/main/java/com/erp/core/approval/ApprovalController.java', SRC.APPROVAL_CONTROLLER, true],
    ['src/main/java/com/erp/core/approval/ApprovalRequest.java', SRC.APPROVAL_REQUEST],
    ['src/main/java/com/erp/core/approval/ApprovalStep.java', SRC.APPROVAL_STEP],
    ['src/main/java/com/erp/core/approval/ApprovalRepository.java', SRC.APPROVAL_REPOSITORY],
    ['src/main/java/com/erp/core/approval/ApprovalDto.java', SRC.APPROVAL_DTO],
    ['src/main/java/com/erp/core/approval/ApprovalState.java', SRC.APPROVAL_STATE],
    ['src/main/java/com/erp/core/invoice/InvoiceService.java', SRC.INVOICE_SERVICE, true],
    ['src/main/java/com/erp/core/invoice/Invoice.java', SRC.INVOICE],
    ['src/main/java/com/erp/core/procurement/PurchaseOrderService.java', SRC.PURCHASE_ORDER_SERVICE],
    ['src/main/java/com/erp/core/procurement/PurchaseOrder.java', SRC.PURCHASE_ORDER],
    ['src/main/java/com/erp/core/common/GlobalExceptionHandler.java', SRC.EXCEPTION_HANDLER],
    ['src/main/java/com/erp/core/config/SecurityConfig.java', SRC.SECURITY_CONFIG],
    ['src/main/java/com/erp/core/audit/AuditAspect.java', SRC.AUDIT_ASPECT, true],
    ['src/main/java/com/erp/core/ErpCoreApplication.java', SRC.APPLICATION],
    ['src/main/resources/application.yml', SRC.APPLICATION_YML],
    ['src/main/resources/application-prod.yml', SRC.APPLICATION_PROD_YML],
    ['src/main/resources/logback-spring.xml', SRC.LOGBACK_XML],
    ['pom.xml', SRC.POM_XML],
    ['src/test/java/com/erp/core/approval/ApprovalWorkflowServiceTest.java', SRC.WORKFLOW_TEST, true],
    ['src/test/java/com/erp/core/invoice/InvoiceServiceTest.java', SRC.INVOICE_TEST],
    ['Dockerfile', SRC.DOCKERFILE],
    ['.gitlab-ci.yml', SRC.GITLAB_CI],
    ['docs/adr/0007-approval-state-machine.md', SRC.ADR_0007],
    ['README.md', SRC.README],
  ],
  tree: () => [
    d('docs', [
      d('adr', [fnode('docs/adr/0007-approval-state-machine.md')], true),
    ], true),
    d('src', [
      d('main', [
        d('java', [
          d('com', [
            d('erp', [
              d('core', [
                d('approval', [
                  fnode('src/main/java/com/erp/core/approval/ApprovalController.java'),
                  fnode('src/main/java/com/erp/core/approval/ApprovalDto.java'),
                  fnode('src/main/java/com/erp/core/approval/ApprovalRepository.java'),
                  fnode('src/main/java/com/erp/core/approval/ApprovalRequest.java'),
                  fnode('src/main/java/com/erp/core/approval/ApprovalState.java'),
                  fnode('src/main/java/com/erp/core/approval/ApprovalStep.java'),
                  fnode('src/main/java/com/erp/core/approval/ApprovalWorkflowService.java'),
                ], true),
                d('audit', [
                  fnode('src/main/java/com/erp/core/audit/AuditAspect.java'),
                ], true),
                d('common', [
                  fnode('src/main/java/com/erp/core/common/GlobalExceptionHandler.java'),
                ]),
                d('config', [
                  fnode('src/main/java/com/erp/core/config/SecurityConfig.java'),
                ]),
                d('invoice', [
                  fnode('src/main/java/com/erp/core/invoice/Invoice.java'),
                  fnode('src/main/java/com/erp/core/invoice/InvoiceService.java'),
                ], true),
                d('procurement', [
                  fnode('src/main/java/com/erp/core/procurement/PurchaseOrder.java'),
                  fnode('src/main/java/com/erp/core/procurement/PurchaseOrderService.java'),
                ]),
                fnode('src/main/java/com/erp/core/ErpCoreApplication.java'),
              ], true),
            ], true),
          ], true),
        ], true),
        d('resources', [
          d('db', [
            d('migration', [
              fnode('src/main/resources/db/migration/V23__approval_workflow.sql'),
            ], true),
          ], true),
          fnode('src/main/resources/application.yml'),
          fnode('src/main/resources/application-prod.yml'),
          fnode('src/main/resources/logback-spring.xml'),
        ], true),
      ], true),
      d('test', [
        d('java', [
          d('com', [
            d('erp', [
              d('core', [
                d('approval', [
                  fnode('src/test/java/com/erp/core/approval/ApprovalWorkflowServiceTest.java'),
                ], true),
                d('invoice', [
                  fnode('src/test/java/com/erp/core/invoice/InvoiceServiceTest.java'),
                ]),
              ], true),
            ], true),
          ], true),
        ], true),
      ]),
    ], true),
    d('target', []),
    fnode('.gitlab-ci.yml'),
    fnode('Dockerfile'),
    fnode('pom.xml'),
    fnode('README.md'),
  ],
});
})();
