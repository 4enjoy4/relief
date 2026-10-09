/* FauxCode profile: DevOps & Cloud infrastructure — atlas-infra */
(function () {
'use strict';
const SRC = {};

/* ---------- generated-file bases ---------- */

SRC.PROD_MAIN = `# atlas-infra / terraform/environments/prod — the platform team's production account.
#
# OPS-2210: EKS 1.30 -> 1.31 upgrade. Everything below is applied by the CI
# "apply" job from main. A human runs plan, a pipeline runs apply, and the
# state file remembers who was right.

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.32"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.15"
    }
  }
}

provider "aws" {
  region = var.region

  assume_role {
    role_arn = var.deploy_role_arn
  }

  default_tags {
    tags = local.tags
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

data "aws_eks_cluster_auth" "main" {
  name = module.eks.cluster_name
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_ca)
  token                  = data.aws_eks_cluster_auth.main.token
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_ca)
    token                  = data.aws_eks_cluster_auth.main.token
  }
}

locals {
  name = "atlas-prod"
  azs  = slice(data.aws_availability_zones.available.names, 0, 3)

  private_subnet_ids = module.vpc.private_subnet_ids
  public_subnet_ids  = module.vpc.public_subnet_ids

  tags = {
    Project     = "atlas"
    Environment = "prod"
    ManagedBy   = "terraform"
    Owner       = "platform-team"
    CostCenter  = "CC-4410"
  }
}

module "vpc" {
  source = "../../modules/vpc"

  name = local.name
  cidr = var.vpc_cidr
  azs  = local.azs

  private_subnets = [for i in range(3) : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets  = [for i in range(3) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  enable_nat_gateway = true
  # One NAT gateway per AZ. The year we had one, it lived in the AZ that went.
  single_nat_gateway = false
}

module "eks" {
  source = "../../modules/eks"

  cluster_name    = local.name
  cluster_version = var.eks_version
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = local.private_subnet_ids

  node_groups = {
    platform = {
      instance_types = ["m6i.xlarge"]
      min_size       = 3
      max_size       = 12
      desired_size   = 6
      labels         = { role = "platform" }
      taints         = []
    }
    batch = {
      instance_types = ["c6i.2xlarge"]
      min_size       = 0
      max_size       = 20
      desired_size   = 2
      labels         = { role = "batch" }
      taints         = [{ key = "workload", value = "batch", effect = "NO_SCHEDULE" }]
    }
  }

  tags = local.tags
}

resource "aws_sns_topic" "alerts" {
  name              = "atlas-prod-alerts"
  kms_master_key_id = "alias/aws/sns"
}
`;

SRC.PLATFORM_BASE = `# k8s/base/platform.yaml — kustomize base for the platform namespace.
#
# Overlays (k8s/overlays/prod, k8s/overlays/staging) rename the namespace to
# platform-prod / platform-staging and patch replicas and image tags. Argo CD
# syncs the overlays; nobody runs kubectl apply against this by hand.
# Nobody admits to it, at least.
---
apiVersion: v1
kind: Namespace
metadata:
  name: platform
  labels:
    app.kubernetes.io/part-of: platform
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
  annotations:
    platform.internal/owner: platform-team
    platform.internal/ticket: OPS-2210
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-with-exceptions
  namespace: platform
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
        - podSelector: {}
  egress:
    - to:
        - podSelector: {}
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 169.254.169.254/32
      ports:
        - protocol: TCP
          port: 443
`;

/* ---------- atlasctl (Go) ---------- */

SRC.MAIN_GO = `// atlasctl — the platform team's drift detector and rollout helper.
//
//	atlasctl drift     compares terraform state with what AWS actually has
//	atlasctl rollout   waits for, restarts or inspects deployments in EKS
//	atlasctl version   prints build info so support tickets can be triaged
//
// OPS-2204 introduced drift; OPS-2210 runs it before and after every EKS
// upgrade step. If drift finds nothing, either the account is clean or the
// credentials are wrong. Check the second one first.
package main

import (
    "context"
    "errors"
    "fmt"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/spf13/cobra"

    "gitlab.internal.corp/platform/atlas-infra/internal/aws"
    "gitlab.internal.corp/platform/atlas-infra/internal/drift"
    "gitlab.internal.corp/platform/atlas-infra/internal/k8s"
)

// Set by -ldflags at build time; see the Makefile.
var (
    version = "dev"
    commit  = "none"
    date    = "unknown"
)

type globalOptions struct {
    env     string
    region  string
    profile string
    timeout time.Duration
    verbose bool
}

func main() {
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()

    if err := newRootCmd().ExecuteContext(ctx); err != nil {
        var found *drift.DriftFoundError
        if errors.As(err, &found) {
            // Drift is a finding, not a crash. Exit 3 so CI can tell the difference.
            fmt.Fprintln(os.Stderr, err)
            os.Exit(3)
        }
        fmt.Fprintln(os.Stderr, "atlasctl:", err)
        os.Exit(1)
    }
}

func newRootCmd() *cobra.Command {
    opts := &globalOptions{}
    root := &cobra.Command{
        Use:           "atlasctl",
        Short:         "Drift detection and rollout helpers for atlas-infra",
        SilenceUsage:  true,
        SilenceErrors: true,
    }
    pf := root.PersistentFlags()
    pf.StringVar(&opts.env, "env", "staging", "environment to inspect (staging|prod)")
    pf.StringVar(&opts.region, "region", "eu-central-1", "AWS region")
    pf.StringVar(&opts.profile, "profile", "", "AWS profile (defaults to the ambient credentials)")
    pf.DurationVar(&opts.timeout, "timeout", 10*time.Minute, "overall deadline for the command")
    pf.BoolVarP(&opts.verbose, "verbose", "v", false, "log every API call, for the brave")

    root.AddCommand(newDriftCmd(opts), newRolloutCmd(opts), newVersionCmd())
    return root
}

func newDriftCmd(opts *globalOptions) *cobra.Command {
    var (
        dryRun  bool
        format  string
        include []string
    )
    cmd := &cobra.Command{
        Use:   "drift",
        Short: "Compare terraform state with live AWS resources",
        RunE: func(cmd *cobra.Command, args []string) error {
            ctx, cancel := context.WithTimeout(cmd.Context(), opts.timeout)
            defer cancel()

            client, err := aws.NewClient(ctx, aws.Options{Region: opts.region, Profile: opts.profile, Verbose: opts.verbose})
            if err != nil {
                return fmt.Errorf("aws client: %w", err)
            }
            det := drift.NewDetector(client, drift.Config{
                Env:         opts.env,
                StateBucket: "atlas-terraform-state-" + opts.env,
                StateKey:    "environments/" + opts.env + "/terraform.tfstate",
                Include:     include,
                DryRun:      dryRun,
            })
            report, err := det.Run(ctx)
            if err != nil {
                return err
            }
            if err := drift.Render(cmd.OutOrStdout(), report, format); err != nil {
                return err
            }
            if report.HasDrift() && !dryRun {
                return &drift.DriftFoundError{Count: report.DriftedCount()}
            }
            return nil
        },
    }
    cmd.Flags().BoolVar(&dryRun, "dry-run", false, "report drift but exit 0 (what the debug launch config uses)")
    cmd.Flags().StringVar(&format, "format", "table", "output format: table|json|markdown")
    cmd.Flags().StringSliceVar(&include, "include", nil, "only inspect these resource types (e.g. aws_eks_node_group)")
    return cmd
}

func newRolloutCmd(opts *globalOptions) *cobra.Command {
    cmd := &cobra.Command{Use: "rollout", Short: "Inspect and nudge deployments in the cluster"}
    var namespace string
    cmd.PersistentFlags().StringVarP(&namespace, "namespace", "n", "platform-prod", "namespace of the deployment")

    status := &cobra.Command{
        Use:   "status <deployment>",
        Short: "Wait until a deployment is fully rolled out",
        Args:  cobra.ExactArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            ctx, cancel := context.WithTimeout(cmd.Context(), opts.timeout)
            defer cancel()
            cs, err := k8s.NewClientset()
            if err != nil {
                return err
            }
            return k8s.WaitForRollout(ctx, cs, namespace, args[0], k8s.WaitOptions{Poll: 5 * time.Second, Log: cmd.ErrOrStderr()})
        },
    }
    restart := &cobra.Command{
        Use:   "restart <deployment>",
        Short: "Trigger a rolling restart and wait for it",
        Args:  cobra.ExactArgs(1),
        RunE: func(cmd *cobra.Command, args []string) error {
            ctx, cancel := context.WithTimeout(cmd.Context(), opts.timeout)
            defer cancel()
            cs, err := k8s.NewClientset()
            if err != nil {
                return err
            }
            if err := k8s.Restart(ctx, cs, namespace, args[0]); err != nil {
                return err
            }
            return k8s.WaitForRollout(ctx, cs, namespace, args[0], k8s.WaitOptions{Poll: 5 * time.Second, Log: cmd.ErrOrStderr()})
        },
    }
    cmd.AddCommand(status, restart)
    return cmd
}

func newVersionCmd() *cobra.Command {
    return &cobra.Command{
        Use:   "version",
        Short: "Print version information",
        Run: func(cmd *cobra.Command, args []string) {
            fmt.Fprintf(cmd.OutOrStdout(), "atlasctl %s (%s) built %s\\n", version, commit, date)
        },
    }
}
`;

SRC.DETECTOR_GO = `// Package drift compares the resources recorded in a terraform state file
// with what the cloud provider reports right now.
//
// The comparison is deliberately shallow: a handful of attributes per
// resource type that have actually drifted in this account before. A full
// diff of every attribute would be more correct, and would page someone
// every time AWS invents a new default tag.
package drift

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "sort"
    "strings"
    "time"

    "gitlab.internal.corp/platform/atlas-infra/internal/aws"
)

// Config controls one detector run.
type Config struct {
    Env         string
    StateBucket string
    StateKey    string
    Include     []string // resource types to inspect; empty means every supported type
    DryRun      bool
}

// Fetcher is the slice of the AWS client the detector needs. It is an
// interface so the tests can lie to it.
type Fetcher interface {
    GetObject(ctx context.Context, bucket, key string) ([]byte, error)
    DescribeResource(ctx context.Context, rtype, id string) (map[string]string, error)
}

// Detector loads a state file and checks each supported resource against live.
type Detector struct {
    fetcher Fetcher
    cfg     Config
    log     *slog.Logger
    now     func() time.Time
}

// trackedAttributes lists, per resource type, the attributes worth comparing.
// Everything else is immutable, noise, or both.
var trackedAttributes = map[string][]string{
    "aws_eks_cluster":                   {"version", "endpoint_public_access", "kubernetes_network_config.0.service_ipv4_cidr"},
    "aws_eks_node_group":                {"release_version", "scaling_config.0.desired_size", "scaling_config.0.max_size", "instance_types.0"},
    "aws_security_group":                {"ingress_count", "egress_count"},
    "aws_db_instance":                   {"engine_version", "instance_class", "deletion_protection", "multi_az"},
    "aws_elasticache_replication_group": {"node_type", "num_cache_clusters", "automatic_failover_enabled"},
    "aws_lb":                            {"idle_timeout", "deletion_protection_enabled"},
    "aws_s3_bucket":                     {"versioning", "force_destroy"},
    "aws_iam_role":                      {"max_session_duration", "policy_count"},
}

func NewDetector(f Fetcher, cfg Config) *Detector {
    return &Detector{
        fetcher: f,
        cfg:     cfg,
        log:     slog.Default().With("component", "drift", "env", cfg.Env),
        now:     time.Now,
    }
}

// stateFile is the subset of the terraform state format (version 4) we read.
// encoding/json matches the lowercase keys case-insensitively, so no tags.
type stateFile struct {
    Version   int
    Serial    int
    Resources []stateResource
}

type stateResource struct {
    Mode      string
    Type      string
    Name      string
    Module    string
    Instances []stateInstance
}

type stateInstance struct {
    Attributes map[string]any
}

// Run loads the state, inspects each resource and returns a Report.
func (d *Detector) Run(ctx context.Context) (*Report, error) {
    started := d.now()
    raw, err := d.fetcher.GetObject(ctx, d.cfg.StateBucket, d.cfg.StateKey)
    if err != nil {
        return nil, fmt.Errorf("load state s3://%s/%s: %w", d.cfg.StateBucket, d.cfg.StateKey, err)
    }
    st, err := parseState(raw)
    if err != nil {
        return nil, err
    }
    d.log.Info("state loaded", "serial", st.Serial, "resources", len(st.Resources))

    report := &Report{Env: d.cfg.Env, StateSerial: st.Serial, GeneratedAt: started}
    for _, res := range st.Resources {
        if res.Mode != "managed" || !d.included(res.Type) {
            continue
        }
        for _, inst := range res.Instances {
            finding, err := d.Compare(ctx, res, inst)
            if err != nil {
                // One unreachable resource must not hide the other two hundred.
                report.Errors = append(report.Errors, fmt.Sprintf("%s.%s: %v", res.Type, res.Name, err))
                continue
            }
            report.Findings = append(report.Findings, finding)
        }
    }
    sort.Slice(report.Findings, func(i, j int) bool {
        if report.Findings[i].Severity != report.Findings[j].Severity {
            return report.Findings[i].Severity > report.Findings[j].Severity
        }
        return report.Findings[i].Address < report.Findings[j].Address
    })
    report.Duration = d.now().Sub(started)
    d.log.Info("drift check finished", "drifted", report.DriftedCount(), "checked", len(report.Findings), "took", report.Duration)
    return report, nil
}

// Compare fetches the live attributes of one resource instance and diffs the
// tracked ones against the state.
func (d *Detector) Compare(ctx context.Context, res stateResource, inst stateInstance) (Finding, error) {
    id, _ := inst.Attributes["id"].(string)
    finding := Finding{Address: address(res), Type: res.Type, ID: id, Severity: SeverityOK}
    if id == "" {
        finding.Severity = SeverityWarn
        finding.Note = "instance has no id in state (tainted, or somebody is mid-apply)"
        return finding, nil
    }

    live, err := d.fetcher.DescribeResource(ctx, res.Type, id)
    if err != nil {
        if aws.IsNotFound(err) {
            finding.Severity = SeverityCritical
            finding.Note = "resource exists in state but not in AWS"
            return finding, nil
        }
        return finding, err
    }

    for _, attr := range trackedAttributes[res.Type] {
        want := flatten(inst.Attributes, attr)
        got, ok := live[attr]
        if !ok {
            continue // the describe call does not know this attribute; that is ignorance, not drift
        }
        if want != got {
            finding.Diffs = append(finding.Diffs, Diff{Attribute: attr, State: want, Live: got})
        }
    }
    if len(finding.Diffs) > 0 {
        finding.Severity = severityFor(res.Type, finding.Diffs)
    }
    return finding, nil
}

func (d *Detector) included(rtype string) bool {
    if _, supported := trackedAttributes[rtype]; !supported {
        return false
    }
    if len(d.cfg.Include) == 0 {
        return true
    }
    for _, t := range d.cfg.Include {
        if t == rtype {
            return true
        }
    }
    return false
}

func parseState(raw []byte) (*stateFile, error) {
    var st stateFile
    if err := json.Unmarshal(raw, &st); err != nil {
        return nil, fmt.Errorf("parse state: %w", err)
    }
    if st.Version != 4 {
        return nil, fmt.Errorf("unsupported state version %d (want 4)", st.Version)
    }
    return &st, nil
}

func address(res stateResource) string {
    if res.Module != "" {
        return res.Module + "." + res.Type + "." + res.Name
    }
    return res.Type + "." + res.Name
}

// flatten resolves a dotted attribute path like "scaling_config.0.desired_size"
// against the nested state attributes and renders the leaf as a string.
func flatten(attrs map[string]any, path string) string {
    var cur any = attrs
    for _, part := range strings.Split(path, ".") {
        switch node := cur.(type) {
        case map[string]any:
            cur = node[part]
        case []any:
            var idx int
            if _, err := fmt.Sscanf(part, "%d", &idx); err != nil || idx < 0 || idx >= len(node) {
                return ""
            }
            cur = node[idx]
        default:
            return ""
        }
    }
    switch v := cur.(type) {
    case nil:
        return ""
    case string:
        return v
    case float64:
        if v == float64(int64(v)) {
            return fmt.Sprintf("%d", int64(v))
        }
        return fmt.Sprintf("%g", v)
    case bool:
        return fmt.Sprintf("%t", v)
    default:
        b, _ := json.Marshal(v)
        return string(b)
    }
}

// severityFor decides how loudly to complain. A drifted deletion_protection
// flag is critical; a desired_size the autoscaler moved is a Tuesday.
func severityFor(rtype string, diffs []Diff) Severity {
    sev := SeverityInfo
    for _, df := range diffs {
        s := SeverityWarn
        switch {
        case strings.Contains(df.Attribute, "deletion_protection"), df.Attribute == "version", df.Attribute == "engine_version":
            s = SeverityCritical
        case rtype == "aws_eks_node_group" && strings.HasSuffix(df.Attribute, "desired_size"):
            s = SeverityInfo // the autoscaler moved it; that is literally its job
        }
        if s > sev {
            sev = s
        }
    }
    return sev
}
`;

SRC.REPORT_GO = `package drift

import (
    "encoding/json"
    "fmt"
    "io"
    "strings"
    "text/tabwriter"
    "time"
)

// Severity orders findings. Higher is worse, which is also how the on-call
// rotation is ordered.
type Severity int

const (
    SeverityOK Severity = iota
    SeverityInfo
    SeverityWarn
    SeverityCritical
)

func (s Severity) String() string {
    switch s {
    case SeverityOK:
        return "ok"
    case SeverityInfo:
        return "info"
    case SeverityWarn:
        return "warn"
    case SeverityCritical:
        return "critical"
    default:
        return fmt.Sprintf("severity(%d)", int(s))
    }
}

// MarshalText makes the JSON output say "warn" instead of 2.
func (s Severity) MarshalText() ([]byte, error) { return []byte(s.String()), nil }

type Diff struct {
    Attribute string
    State     string
    Live      string
}

type Finding struct {
    Address  string
    Type     string
    ID       string
    Severity Severity
    Diffs    []Diff
    Note     string
}

func (f Finding) Drifted() bool { return f.Severity > SeverityOK }

// Report is the result of one detector run.
type Report struct {
    Env         string
    StateSerial int
    GeneratedAt time.Time
    Duration    time.Duration
    Findings    []Finding
    Errors      []string
}

func (r *Report) HasDrift() bool { return r.DriftedCount() > 0 }

func (r *Report) DriftedCount() int {
    n := 0
    for _, f := range r.Findings {
        if f.Drifted() {
            n++
        }
    }
    return n
}

// Worst returns the highest severity in the report.
func (r *Report) Worst() Severity {
    worst := SeverityOK
    for _, f := range r.Findings {
        if f.Severity > worst {
            worst = f.Severity
        }
    }
    return worst
}

// DriftFoundError is returned by the CLI when drift exists and --dry-run is off.
type DriftFoundError struct{ Count int }

func (e *DriftFoundError) Error() string {
    return fmt.Sprintf("drift detected in %d resource(s); run terraform plan before touching anything", e.Count)
}

// Render writes the report in the requested format.
func Render(w io.Writer, r *Report, format string) error {
    switch strings.ToLower(format) {
    case "json":
        enc := json.NewEncoder(w)
        enc.SetIndent("", "  ")
        return enc.Encode(r)
    case "markdown", "md":
        return renderMarkdown(w, r)
    case "table", "":
        return renderTable(w, r)
    default:
        return fmt.Errorf("unknown format %q (table|json|markdown)", format)
    }
}

func renderTable(w io.Writer, r *Report) error {
    tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
    fmt.Fprintf(tw, "SEVERITY\\tADDRESS\\tATTRIBUTE\\tSTATE\\tLIVE\\n")
    for _, f := range r.Findings {
        if !f.Drifted() {
            continue
        }
        if len(f.Diffs) == 0 {
            fmt.Fprintf(tw, "%s\\t%s\\t-\\t-\\t%s\\n", f.Severity, f.Address, f.Note)
            continue
        }
        for i, d := range f.Diffs {
            addr := f.Address
            if i > 0 {
                addr = "" // the eye reads the blank as ditto; the tabwriter reads it as a column
            }
            fmt.Fprintf(tw, "%s\\t%s\\t%s\\t%s\\t%s\\n", f.Severity, addr, d.Attribute, orDash(d.State), orDash(d.Live))
        }
    }
    if err := tw.Flush(); err != nil {
        return err
    }
    fmt.Fprintf(w, "\\n%d checked, %d drifted, %d errors, worst=%s, state serial %d, %s\\n",
        len(r.Findings), r.DriftedCount(), len(r.Errors), r.Worst(), r.StateSerial, r.Duration.Round(time.Millisecond))
    for _, e := range r.Errors {
        fmt.Fprintf(w, "error: %s\\n", e)
    }
    return nil
}

func renderMarkdown(w io.Writer, r *Report) error {
    fmt.Fprintf(w, "## Drift report: %s (state serial %d)\\n\\n", r.Env, r.StateSerial)
    if !r.HasDrift() {
        _, err := fmt.Fprintln(w, "No drift. Enjoy it while it lasts.")
        return err
    }
    fmt.Fprintln(w, "| Severity | Address | Attribute | State | Live |")
    fmt.Fprintln(w, "|---|---|---|---|---|")
    for _, f := range r.Findings {
        if !f.Drifted() {
            continue
        }
        if len(f.Diffs) == 0 {
            fmt.Fprintf(w, "| %s | %s | - | - | %s |\\n", f.Severity, f.Address, f.Note)
        }
        for _, d := range f.Diffs {
            fmt.Fprintf(w, "| %s | %s | %s | %s | %s |\\n", f.Severity, f.Address, d.Attribute, orDash(d.State), orDash(d.Live))
        }
    }
    _, err := fmt.Fprintf(w, "\\n_%d checked, %d drifted, generated %s_\\n", len(r.Findings), r.DriftedCount(), r.GeneratedAt.UTC().Format(time.RFC3339))
    return err
}

func orDash(s string) string {
    if s == "" {
        return "-"
    }
    return s
}
`;

SRC.AWS_CLIENT_GO = `// Package aws wraps the handful of SDK calls atlasctl needs behind one
// client, so the rest of the code never imports the SDK directly and the
// tests never need credentials.
package aws

import (
    "context"
    "errors"
    "fmt"
    "io"
    "log/slog"
    "strconv"
    "strings"

    awssdk "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/eks"
    "github.com/aws/aws-sdk-go-v2/service/rds"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/aws/aws-sdk-go-v2/service/sts"
    "github.com/aws/smithy-go"
)

type Options struct {
    Region  string
    Profile string
    Verbose bool
}

// Client is a thin facade over the SDK service clients.
type Client struct {
    cfg awssdk.Config
    s3  *s3.Client
    eks *eks.Client
    rds *rds.Client
    sts *sts.Client
    log *slog.Logger
}

// ErrNotFound is wrapped by DescribeResource when the resource is gone.
var ErrNotFound = errors.New("resource not found")

func IsNotFound(err error) bool { return errors.Is(err, ErrNotFound) }

func NewClient(ctx context.Context, opts Options) (*Client, error) {
    loaders := []func(*config.LoadOptions) error{config.WithRegion(opts.Region)}
    if opts.Profile != "" {
        loaders = append(loaders, config.WithSharedConfigProfile(opts.Profile))
    }
    if opts.Verbose {
        loaders = append(loaders, config.WithClientLogMode(awssdk.LogRequest|awssdk.LogResponseWithBody))
    }
    cfg, err := config.LoadDefaultConfig(ctx, loaders...)
    if err != nil {
        return nil, fmt.Errorf("load aws config: %w", err)
    }
    c := &Client{
        cfg: cfg,
        s3:  s3.NewFromConfig(cfg),
        eks: eks.NewFromConfig(cfg),
        rds: rds.NewFromConfig(cfg),
        sts: sts.NewFromConfig(cfg),
        log: slog.Default().With("component", "aws", "region", opts.Region),
    }
    ident, err := c.sts.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
    if err != nil {
        return nil, fmt.Errorf("sts get-caller-identity: %w (is the SSO session still alive?)", err)
    }
    c.log.Info("authenticated", "account", awssdk.ToString(ident.Account), "arn", awssdk.ToString(ident.Arn))
    return c, nil
}

// GetObject downloads a whole object. State files are a few MB at most; the
// day that stops being true we have bigger problems than memory.
func (c *Client) GetObject(ctx context.Context, bucket, key string) ([]byte, error) {
    out, err := c.s3.GetObject(ctx, &s3.GetObjectInput{Bucket: awssdk.String(bucket), Key: awssdk.String(key)})
    if err != nil {
        return nil, translate(err)
    }
    defer out.Body.Close()
    body, err := io.ReadAll(out.Body)
    if err != nil {
        return nil, fmt.Errorf("read s3://%s/%s: %w", bucket, key, err)
    }
    return body, nil
}

// DescribeResource returns the live values of the attributes the drift
// detector tracks, keyed the way terraform state names them.
func (c *Client) DescribeResource(ctx context.Context, rtype, id string) (map[string]string, error) {
    switch rtype {
    case "aws_eks_cluster":
        return c.describeCluster(ctx, id)
    case "aws_eks_node_group":
        return c.describeNodeGroup(ctx, id)
    case "aws_db_instance":
        return c.describeDBInstance(ctx, id)
    default:
        return nil, fmt.Errorf("describe %s: unsupported resource type", rtype)
    }
}

func (c *Client) describeCluster(ctx context.Context, name string) (map[string]string, error) {
    out, err := c.eks.DescribeCluster(ctx, &eks.DescribeClusterInput{Name: awssdk.String(name)})
    if err != nil {
        return nil, translate(err)
    }
    cl := out.Cluster
    attrs := map[string]string{
        "version": awssdk.ToString(cl.Version),
    }
    if cl.ResourcesVpcConfig != nil {
        attrs["endpoint_public_access"] = strconv.FormatBool(cl.ResourcesVpcConfig.EndpointPublicAccess)
    }
    if cl.KubernetesNetworkConfig != nil {
        attrs["kubernetes_network_config.0.service_ipv4_cidr"] = awssdk.ToString(cl.KubernetesNetworkConfig.ServiceIpv4Cidr)
    }
    return attrs, nil
}

// Node group ids in state are "<cluster>:<nodegroup>". The colon is load-bearing.
func (c *Client) describeNodeGroup(ctx context.Context, id string) (map[string]string, error) {
    cluster, group, ok := strings.Cut(id, ":")
    if !ok {
        return nil, fmt.Errorf("node group id %q is not cluster:name", id)
    }
    out, err := c.eks.DescribeNodegroup(ctx, &eks.DescribeNodegroupInput{ClusterName: awssdk.String(cluster), NodegroupName: awssdk.String(group)})
    if err != nil {
        return nil, translate(err)
    }
    ng := out.Nodegroup
    attrs := map[string]string{
        "release_version": awssdk.ToString(ng.ReleaseVersion),
    }
    if ng.ScalingConfig != nil {
        attrs["scaling_config.0.desired_size"] = strconv.Itoa(int(awssdk.ToInt32(ng.ScalingConfig.DesiredSize)))
        attrs["scaling_config.0.max_size"] = strconv.Itoa(int(awssdk.ToInt32(ng.ScalingConfig.MaxSize)))
    }
    if len(ng.InstanceTypes) > 0 {
        attrs["instance_types.0"] = ng.InstanceTypes[0]
    }
    return attrs, nil
}

func (c *Client) describeDBInstance(ctx context.Context, id string) (map[string]string, error) {
    out, err := c.rds.DescribeDBInstances(ctx, &rds.DescribeDBInstancesInput{DBInstanceIdentifier: awssdk.String(id)})
    if err != nil {
        return nil, translate(err)
    }
    if len(out.DBInstances) == 0 {
        return nil, ErrNotFound
    }
    db := out.DBInstances[0]
    return map[string]string{
        "engine_version":      awssdk.ToString(db.EngineVersion),
        "instance_class":      awssdk.ToString(db.DBInstanceClass),
        "deletion_protection": strconv.FormatBool(awssdk.ToBool(db.DeletionProtection)),
        "multi_az":            strconv.FormatBool(awssdk.ToBool(db.MultiAZ)),
    }, nil
}

// translate maps the SDK's many ways of saying "gone" onto ErrNotFound and
// leaves everything else alone.
func translate(err error) error {
    var apiErr smithy.APIError
    if errors.As(err, &apiErr) {
        switch apiErr.ErrorCode() {
        case "ResourceNotFoundException", "NoSuchKey", "NoSuchBucket", "DBInstanceNotFound":
            return fmt.Errorf("%w: %s", ErrNotFound, apiErr.ErrorMessage())
        }
    }
    return err
}
`;

SRC.ROLLOUT_GO = `// Package k8s holds the small amount of client-go atlasctl needs: build a
// clientset from the ambient kubeconfig, wait for a Deployment to settle and
// kick one when it will not. It is not a kubectl replacement. kubectl is
// right there.
package k8s

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/clientcmd"
)

// ErrTimeout is returned when the deadline passes before the rollout settles.
var ErrTimeout = errors.New("rollout did not complete before the deadline")

// NewClientset builds a clientset from KUBECONFIG or ~/.kube/config. In-cluster
// config is deliberately unsupported: atlasctl runs on the bastion, on purpose.
func NewClientset() (kubernetes.Interface, error) {
    path := os.Getenv("KUBECONFIG")
    if path == "" {
        home, err := os.UserHomeDir()
        if err != nil {
            return nil, err
        }
        path = filepath.Join(home, ".kube", "config")
    }
    cfg, err := clientcmd.BuildConfigFromFlags("", path)
    if err != nil {
        return nil, fmt.Errorf("kubeconfig %s: %w", path, err)
    }
    cfg.UserAgent = "atlasctl"
    cfg.QPS, cfg.Burst = 20, 40
    return kubernetes.NewForConfig(cfg)
}

type WaitOptions struct {
    Poll time.Duration
    Log  io.Writer
}

// Status is the subset of DeploymentStatus a human wants to see while waiting.
type Status struct {
    Generation, ObservedGeneration     int64
    Desired, Updated, Ready, Available int32
    Reason                             string
}

func (s Status) Done() bool {
    return s.ObservedGeneration >= s.Generation && s.Updated == s.Desired && s.Ready == s.Desired && s.Available == s.Desired
}

func (s Status) String() string {
    return fmt.Sprintf("desired=%d updated=%d ready=%d available=%d gen=%d/%d",
        s.Desired, s.Updated, s.Ready, s.Available, s.ObservedGeneration, s.Generation)
}

// WaitForRollout polls until the deployment is fully rolled out, the context
// ends, or the deployment reports ProgressDeadlineExceeded.
func WaitForRollout(ctx context.Context, cs kubernetes.Interface, namespace, name string, opts WaitOptions) error {
    if opts.Poll <= 0 {
        opts.Poll = 3 * time.Second
    }
    if opts.Log == nil {
        opts.Log = io.Discard
    }
    ticker := time.NewTicker(opts.Poll)
    defer ticker.Stop()

    var last string
    for {
        st, err := GetStatus(ctx, cs, namespace, name)
        if err != nil {
            return err
        }
        if st.Reason == "ProgressDeadlineExceeded" {
            return fmt.Errorf("deployment %s/%s: %s (kubectl describe deploy %s -n %s for the sad details)", namespace, name, st.Reason, name, namespace)
        }
        if line := st.String(); line != last {
            fmt.Fprintf(opts.Log, "%s/%s: %s\\n", namespace, name, line)
            last = line
        }
        if st.Done() {
            fmt.Fprintf(opts.Log, "%s/%s: rolled out\\n", namespace, name)
            return nil
        }
        select {
        case <-ctx.Done():
            return fmt.Errorf("%w: %s/%s (%s)", ErrTimeout, namespace, name, last)
        case <-ticker.C:
        }
    }
}

// GetStatus reads the deployment and condenses its status.
func GetStatus(ctx context.Context, cs kubernetes.Interface, namespace, name string) (Status, error) {
    dep, err := cs.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
    if err != nil {
        return Status{}, fmt.Errorf("get deployment %s/%s: %w", namespace, name, err)
    }
    st := Status{
        Generation:         dep.Generation,
        ObservedGeneration: dep.Status.ObservedGeneration,
        Desired:            1,
        Updated:            dep.Status.UpdatedReplicas,
        Ready:              dep.Status.ReadyReplicas,
        Available:          dep.Status.AvailableReplicas,
    }
    if dep.Spec.Replicas != nil {
        st.Desired = *dep.Spec.Replicas
    }
    for _, cond := range dep.Status.Conditions {
        if cond.Type == appsv1.DeploymentProgressing {
            st.Reason = cond.Reason
        }
    }
    return st, nil
}

// Restart does what kubectl rollout restart does: bump an annotation on the
// pod template so the controller rolls new pods. Nothing else changes, which
// is the whole point.
func Restart(ctx context.Context, cs kubernetes.Interface, namespace, name string) error {
    patch := map[string]any{
        "spec": map[string]any{
            "template": map[string]any{
                "metadata": map[string]any{
                    "annotations": map[string]string{
                        "atlasctl.platform.internal/restartedAt": time.Now().UTC().Format(time.RFC3339),
                    },
                },
            },
        },
    }
    body, err := json.Marshal(patch)
    if err != nil {
        return err
    }
    _, err = cs.AppsV1().Deployments(namespace).Patch(ctx, name, types.StrategicMergePatchType, body, metav1.PatchOptions{FieldManager: "atlasctl"})
    if err != nil {
        return fmt.Errorf("restart %s/%s: %w", namespace, name, err)
    }
    return nil
}
`;

/* ---------- terraform modules & environment ---------- */

SRC.EKS_MAIN = `# modules/eks — an EKS cluster with managed node groups, IRSA and the addons
# we cannot live without. Consumed by terraform/environments/{staging,prod}.
#
# OPS-2210: cluster_version is a validated variable now, after the quarter in
# which it was a literal and staging quietly ran a different minor than prod.

locals {
  addons = {
    coredns = {
      version = var.addon_versions["coredns"]
      configuration = jsonencode({
        replicaCount = 3
        resources    = { requests = { memory = "128Mi" }, limits = { memory = "256Mi" } }
      })
    }
    kube-proxy         = { version = var.addon_versions["kube-proxy"], configuration = null }
    vpc-cni            = { version = var.addon_versions["vpc-cni"], configuration = jsonencode({ env = { ENABLE_PREFIX_DELEGATION = "true" } }) }
    aws-ebs-csi-driver = { version = var.addon_versions["aws-ebs-csi-driver"], configuration = null }
  }
}

data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = format("%s-cluster", var.cluster_name)
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController",
  ])
  role       = aws_iam_role.cluster.name
  policy_arn = each.value
}

resource "aws_security_group" "cluster" {
  name        = format("%s-cluster", var.cluster_name)
  description = "EKS control plane <-> nodes"
  vpc_id      = var.vpc_id
  tags        = var.tags
}

resource "aws_cloudwatch_log_group" "cluster" {
  name              = format("/aws/eks/%s/cluster", var.cluster_name)
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_eks_cluster" "this" {
  name     = var.cluster_name
  version  = var.cluster_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = var.subnet_ids
    security_group_ids      = [aws_security_group.cluster.id]
    endpoint_private_access = true
    endpoint_public_access  = var.endpoint_public_access
    public_access_cidrs     = var.endpoint_public_access ? var.public_access_cidrs : []
  }

  kubernetes_network_config {
    service_ipv4_cidr = var.service_ipv4_cidr
    ip_family         = "ipv4"
  }

  access_config {
    authentication_mode                         = "API_AND_CONFIG_MAP"
    bootstrap_cluster_creator_admin_permissions = false
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  # The control plane upgrade takes ~25 minutes. The node groups below follow
  # it one at a time, which is the slow part and also the safe part.
  upgrade_policy {
    support_type = "STANDARD"
  }

  depends_on = [
    aws_iam_role_policy_attachment.cluster,
    aws_cloudwatch_log_group.cluster,
  ]

  tags = var.tags
}

data "tls_certificate" "oidc" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "this" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  tags            = var.tags
}

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = format("%s-node", var.cluster_name)
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

resource "aws_launch_template" "node" {
  for_each = var.node_groups

  name_prefix            = format("%s-%s-", var.cluster_name, each.key)
  update_default_version = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only; the pods do not need to know who they are
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 80
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = format("%s-%s", var.cluster_name, each.key), NodeGroup = each.key })
  }
}

resource "aws_eks_node_group" "this" {
  for_each = var.node_groups

  cluster_name    = aws_eks_cluster.this.name
  node_group_name = each.key
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.subnet_ids
  instance_types  = each.value.instance_types
  capacity_type   = "ON_DEMAND"
  ami_type        = "AL2023_x86_64_STANDARD"
  release_version = var.node_release_version
  labels          = each.value.labels

  scaling_config {
    desired_size = each.value.desired_size
    min_size     = each.value.min_size
    max_size     = each.value.max_size
  }

  update_config {
    max_unavailable_percentage = 25
  }

  launch_template {
    id      = aws_launch_template.node[each.key].id
    version = aws_launch_template.node[each.key].latest_version
  }

  dynamic "taint" {
    for_each = each.value.taints
    content {
      key    = taint.value.key
      value  = taint.value.value
      effect = taint.value.effect
    }
  }

  lifecycle {
    # The cluster autoscaler owns desired_size after the first apply. Terraform
    # is told this once, in writing, and reminded on every plan.
    ignore_changes = [scaling_config[0].desired_size]
  }

  depends_on = [aws_iam_role_policy_attachment.node]

  tags = merge(var.tags, { NodeGroup = each.key })
}

resource "aws_eks_addon" "this" {
  for_each = local.addons

  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = each.key
  addon_version               = each.value.version
  configuration_values        = each.value.configuration
  resolve_conflicts_on_update = "OVERWRITE"

  # Addons go after the node groups so coredns has somewhere to live.
  depends_on = [aws_eks_node_group.this]
  tags       = var.tags
}
`;

SRC.EKS_VARIABLES = `variable "cluster_name" {
  description = "Name of the EKS cluster. Also the prefix for every IAM role and security group the module creates."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,38}$", var.cluster_name))
    error_message = "cluster_name must be lowercase kebab-case, 3-39 characters."
  }
}

variable "cluster_version" {
  description = "Kubernetes minor version, e.g. 1.31. OPS-2210 bumps this one minor at a time; EKS refuses to skip."
  type        = string

  validation {
    condition     = contains(["1.29", "1.30", "1.31"], var.cluster_version)
    error_message = "cluster_version must be a version the platform team has actually tested."
  }
}

variable "node_release_version" {
  description = "AMI release version for the managed node groups. The release notes are the source of truth, not the console."
  type        = string
  default     = null
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets for the control plane ENIs and the nodes. At least two AZs, or EKS will say so at length."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "subnet_ids needs at least two subnets in different availability zones."
  }
}

variable "node_groups" {
  description = "Managed node groups keyed by name."
  type = map(object({
    instance_types = list(string)
    min_size       = number
    max_size       = number
    desired_size   = number
    labels         = map(string)
    taints = list(object({
      key    = string
      value  = string
      effect = string
    }))
  }))
}

variable "endpoint_public_access" {
  description = "Whether the API server gets a public endpoint. prod says no; staging says no, but louder."
  type        = bool
  default     = false
}

variable "public_access_cidrs" {
  type    = list(string)
  default = []
}

variable "service_ipv4_cidr" {
  type    = string
  default = "172.20.0.0/16"
}

variable "addon_versions" {
  description = "Pinned addon versions. Bump in the same MR as cluster_version; see docs/runbooks/eks-upgrade.md."
  type        = map(string)
  default = {
    coredns            = "v1.11.3-eksbuild.2"
    kube-proxy         = "v1.31.0-eksbuild.5"
    vpc-cni            = "v1.18.5-eksbuild.1"
    aws-ebs-csi-driver = "v1.35.0-eksbuild.1"
  }
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "tags" {
  type    = map(string)
  default = {}
}
`;

SRC.EKS_OUTPUTS = `output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "cluster_ca" {
  description = "Base64 encoded CA; the environment providers base64decode it."
  value       = aws_eks_cluster.this.certificate_authority[0].data
  sensitive   = true
}

output "cluster_version" {
  value = aws_eks_cluster.this.version
}

output "platform_version" {
  description = "The eks.N platform version. Useful when support asks, useless otherwise."
  value       = aws_eks_cluster.this.platform_version
}

output "oidc_provider_arn" {
  description = "For IRSA trust policies in the service modules."
  value       = aws_iam_openid_connect_provider.this.arn
}

output "oidc_issuer" {
  value = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

output "node_role_arn" {
  value = aws_iam_role.node.arn
}

output "node_group_ids" {
  description = "cluster:name ids, the format atlasctl drift expects."
  value       = { for k, ng in aws_eks_node_group.this : k => ng.id }
}

output "cluster_security_group_id" {
  value = aws_security_group.cluster.id
}
`;

SRC.PROD_VARIABLES = `variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "deploy_role_arn" {
  description = "Role assumed by CI and by humans on the bastion. Humans get it read-only via a different profile."
  type        = string
  default     = "arn:aws:iam::123456789012:role/platform-deploy"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "eks_version" {
  description = "OPS-2210: 1.30 -> 1.31. Change this last, after addon_versions and the node AMI are ready."
  type        = string
  default     = "1.31"
}

variable "allowed_cidr" {
  description = "Office and VPN ranges allowed to reach the ALB directly. Everyone else meets the WAF."
  type        = string
  default     = "10.0.0.0/8"
}

variable "rds_instance_class" {
  type    = string
  default = "db.r6g.large"
}

variable "rds_engine_version" {
  type    = string
  default = "16.3"
}

variable "redis_node_type" {
  type    = string
  default = "cache.r6g.large"
}

variable "alert_email" {
  description = "Where the SNS topic sends the things nobody reads until the pager does."
  type        = string
  default     = "platform-alerts@example.internal"
}

variable "enable_waf" {
  type    = bool
  default = true
}
`;

SRC.PROD_BACKEND = `# Remote state. The bucket and the lock table are created by the
# terraform/bootstrap stack, which has local state and a README that says
# "do not lose this laptop".

terraform {
  backend "s3" {
    bucket         = "atlas-terraform-state-prod"
    key            = "environments/prod/terraform.tfstate"
    region         = "eu-central-1"
    dynamodb_table = "atlas-terraform-locks"
    encrypt        = true
    kms_key_id     = "alias/atlas-terraform-state"

    # atlasctl drift reads the same bucket and key; keep these in sync with
    # cmd/atlasctl/main.go.
  }
}

# Staging's state lives in a different bucket in a different account, on
# purpose. terraform_remote_state is how prod learns the staging VPC id for
# the peering connection, and nothing else.
data "terraform_remote_state" "staging" {
  backend = "s3"
  config = {
    bucket = "atlas-terraform-state-staging"
    key    = "environments/staging/terraform.tfstate"
    region = "eu-central-1"
  }
}
`;

/* ---------- helm ---------- */

SRC.CHART_YAML = `apiVersion: v2
name: platform
description: The platform services (gateway, auth, billing, notifier, scheduler, search) as one chart, one release, one place to look when it breaks.
type: application
version: 1.14.2
appVersion: "2026.09.1"
kubeVersion: ">=1.29.0-0"
home: https://gitlab.internal.corp/platform/atlas-infra
sources:
  - https://gitlab.internal.corp/platform/atlas-infra/-/tree/main/helm/platform
maintainers:
  - name: platform-team
    email: platform-team@example.internal
keywords:
  - platform
  - gateway
  - argocd
annotations:
  platform.internal/ticket: OPS-2210
  platform.internal/argocd-project: platform
  # Argo CD diffs this chart against the live cluster every three minutes.
  # Anything you change with kubectl edit lasts, at most, three minutes.
dependencies:
  - name: vault-agent-injector
    version: 0.18.x
    repository: https://charts.internal.corp/platform
    condition: vault.injector.enabled
`;

SRC.VALUES_YAML = `# Default values for the platform chart. Environment overlays live in
# helm/platform/values-<env>.yaml and are applied by Argo CD, not by hand.

global:
  registry: registry.internal.corp/platform
  imagePullPolicy: IfNotPresent
  environment: prod
  # Every pod gets these. Cost allocation reads them; so does the on-call.
  labels:
    app.kubernetes.io/part-of: platform
    platform.internal/owner: platform-team

nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: true
  annotations:
    # IRSA: the role is created by terraform (iam-ci); this is only the pointer.
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/atlas-prod-platform

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 10001
  fsGroup: 10001
  seccompProfile:
    type: RuntimeDefault

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]

vault:
  injector:
    enabled: true
  role: platform
  address: https://vault.internal.corp:8200

# One entry per service. Keys become the Deployment names (platform-<key>).
services:
  gateway:
    image: gateway
    tag: "2.41.0"
    replicas: 4
    port: 8080
    resources:
      requests: { cpu: 250m, memory: 256Mi }
      limits: { cpu: "1", memory: 512Mi }
    hpa: { enabled: true, minReplicas: 4, maxReplicas: 16, targetCPU: 65 }
    pdb: { minAvailable: 2 }
    env:
      UPSTREAM_TIMEOUT_MS: "2500"
      RATE_LIMIT_RPS: "800"
  auth:
    image: auth
    tag: "1.19.3"
    replicas: 3
    port: 8081
    resources:
      requests: { cpu: 200m, memory: 256Mi }
      limits: { cpu: "1", memory: 512Mi }
    hpa: { enabled: true, minReplicas: 3, maxReplicas: 10, targetCPU: 70 }
    pdb: { minAvailable: 2 }
    vaultSecrets:
      - path: secret/data/platform/auth/signing-key
        key: signing-key
  billing:
    image: billing
    tag: "3.7.1"
    replicas: 2
    port: 8082
    resources:
      requests: { cpu: 300m, memory: 512Mi }
      limits: { cpu: "2", memory: 1Gi }
    hpa: { enabled: false }
    pdb: { minAvailable: 1 }
    vaultSecrets:
      - path: secret/data/platform/billing/db
        key: dsn
  notifier:
    image: notifier
    tag: "1.4.0"
    replicas: 2
    port: 8083
    resources:
      requests: { cpu: 100m, memory: 128Mi }
      limits: { cpu: 500m, memory: 256Mi }
    hpa: { enabled: true, minReplicas: 2, maxReplicas: 8, targetCPU: 70 }
    pdb: { minAvailable: 1 }
  scheduler:
    image: scheduler
    tag: "0.9.7"
    replicas: 1 # leader election is on the roadmap; until then, one is a crowd
    port: 8084
    resources:
      requests: { cpu: 100m, memory: 128Mi }
      limits: { cpu: 500m, memory: 256Mi }
    hpa: { enabled: false }
    pdb: { minAvailable: 0 }
  search:
    image: search
    tag: "2.2.4"
    replicas: 3
    port: 8085
    resources:
      requests: { cpu: 500m, memory: 1Gi }
      limits: { cpu: "2", memory: 2Gi }
    hpa: { enabled: true, minReplicas: 3, maxReplicas: 12, targetCPU: 60 }
    pdb: { minAvailable: 2 }

probes:
  readiness: { path: /healthz, initialDelaySeconds: 5, periodSeconds: 10 }
  liveness: { path: /livez, periodSeconds: 20, failureThreshold: 3 }

topologySpread:
  enabled: true
  maxSkew: 1

nodeSelector:
  role: platform

tolerations: []

monitoring:
  serviceMonitor:
    enabled: true
    interval: 30s
`;

SRC.DEPLOYMENT_TPL = `{{- /*
  One Deployment per entry in .Values.services. Service, HPA and PDB live in
  their own templates; this one only knows how to run a container and how to
  ask Vault for its secrets. OPS-2210 added the topologySpreadConstraints so a
  node group rollout cannot take every replica of a service at once.
*/}}
{{- $root := . }}
{{- range $name, $svc := .Values.services }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "platform.fullname" $root }}-{{ $name }}
  namespace: {{ $root.Release.Namespace }}
  labels:
    {{- include "platform.labels" $root | nindent 4 }}
    app.kubernetes.io/name: {{ $name }}
  annotations:
    platform.internal/ticket: OPS-2210
spec:
  replicas: {{ $svc.replicas }}
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ $name }}
      app.kubernetes.io/instance: {{ $root.Release.Name }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        {{- include "platform.labels" $root | nindent 8 }}
        app.kubernetes.io/name: {{ $name }}
      annotations:
        checksum/config: {{ toYaml $svc.env | sha256sum }}
        prometheus.io/scrape: "true"
        prometheus.io/port: {{ $svc.port | quote }}
        {{- if and $root.Values.vault.injector.enabled $svc.vaultSecrets }}
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: {{ $root.Values.vault.role }}
        {{- range $svc.vaultSecrets }}
        vault.hashicorp.com/agent-inject-secret-{{ .key }}: {{ .path }}
        {{- end }}
        {{- end }}
    spec:
      serviceAccountName: {{ include "platform.serviceAccountName" $root }}
      securityContext:
        {{- toYaml $root.Values.podSecurityContext | nindent 8 }}
      {{- with $root.Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- if $root.Values.topologySpread.enabled }}
      topologySpreadConstraints:
        - maxSkew: {{ $root.Values.topologySpread.maxSkew }}
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: {{ $name }}
        - maxSkew: {{ $root.Values.topologySpread.maxSkew }}
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: {{ $name }}
      {{- end }}
      containers:
        - name: {{ $name }}
          image: "{{ $root.Values.global.registry }}/{{ $svc.image }}:{{ $svc.tag }}"
          imagePullPolicy: {{ $root.Values.global.imagePullPolicy }}
          securityContext:
            {{- toYaml $root.Values.securityContext | nindent 12 }}
          ports:
            - name: http
              containerPort: {{ $svc.port }}
              protocol: TCP
          env:
            - name: SERVICE_NAME
              value: {{ $name | quote }}
            - name: ENVIRONMENT
              value: {{ $root.Values.global.environment | quote }}
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            {{- range $key, $value := $svc.env }}
            - name: {{ $key }}
              value: {{ $value | quote }}
            {{- end }}
          readinessProbe:
            httpGet:
              path: {{ $root.Values.probes.readiness.path }}
              port: http
            initialDelaySeconds: {{ $root.Values.probes.readiness.initialDelaySeconds }}
            periodSeconds: {{ $root.Values.probes.readiness.periodSeconds }}
          livenessProbe:
            httpGet:
              path: {{ $root.Values.probes.liveness.path }}
              port: http
            periodSeconds: {{ $root.Values.probes.liveness.periodSeconds }}
            failureThreshold: {{ $root.Values.probes.liveness.failureThreshold }}
          resources:
            {{- toYaml $svc.resources | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
      terminationGracePeriodSeconds: 30
{{- end }}
`;

/* ---------- ansible ---------- */

SRC.BOOTSTRAP_PLAYBOOK = `---
# ansible/playbooks/bootstrap-nodes.yml
#
# Bootstraps the EC2 hosts that are NOT managed by EKS: the bastions, the
# Vault nodes and the monitoring box. EKS worker nodes come from the managed
# node groups in terraform/modules/eks and are never touched by Ansible. If
# you find yourself writing a task that targets them, stop, and go read
# docs/runbooks/eks-upgrade.md instead.
#
#   ansible-playbook -i ansible/inventory/prod.ini ansible/playbooks/bootstrap-nodes.yml --limit bastion

- name: Bootstrap platform support hosts
  hosts: support_hosts
  become: true
  gather_facts: true

  vars:
    toolchain_versions:
      kubectl: "1.31.1"
      helm: "3.16.1"
      terraform: "1.9.5"
      atlasctl: "0.7.2"
    node_exporter_version: "1.8.2"
    ssh_allowed_groups: "platform-ops"
    sysctl_settings:
      net.ipv4.ip_forward: 0
      net.ipv4.conf.all.rp_filter: 1
      net.ipv4.tcp_syncookies: 1
      kernel.kptr_restrict: 2
      fs.inotify.max_user_watches: 524288

  pre_tasks:
    - name: Refuse to run against anything that looks like a kubernetes node
      ansible.builtin.assert:
        that:
          - "'eks' not in group_names"
          - "'nodes' not in group_names"
        fail_msg: "This playbook does not touch EKS nodes. It says so at the top."

    - name: Wait for cloud-init to finish before we fight it for apt
      ansible.builtin.command: cloud-init status --wait
      changed_when: false
      failed_when: false

  tasks:
    - name: Apply kernel parameters
      ansible.posix.sysctl:
        name: "{{ item.key }}"
        value: "{{ item.value }}"
        state: present
        reload: true
      loop: "{{ sysctl_settings | dict2items }}"

    - name: Install base packages
      ansible.builtin.apt:
        name:
          - unzip
          - jq
          - chrony
          - auditd
          - fail2ban
          - unattended-upgrades
        state: present
        update_cache: true
        cache_valid_time: 3600

    - name: Restrict SSH to the ops group and keys only
      ansible.builtin.lineinfile:
        path: /etc/ssh/sshd_config
        regexp: "{{ item.regexp }}"
        line: "{{ item.line }}"
        validate: sshd -t -f %s
      loop:
        - { regexp: "^#?PasswordAuthentication", line: "PasswordAuthentication no" }
        - { regexp: "^#?PermitRootLogin", line: "PermitRootLogin no" }
        - { regexp: "^#?AllowGroups", line: "AllowGroups {{ ssh_allowed_groups }}" }
      notify: restart sshd

    - name: Install the SSM agent so we can stop pretending SSH is the only door
      ansible.builtin.snap:
        name: amazon-ssm-agent
        classic: true

    - name: Install the toolchain (bastion only)
      ansible.builtin.include_role:
        name: toolchain
      vars:
        versions: "{{ toolchain_versions }}"
      when: "'bastion' in group_names"

    - name: Download node_exporter
      ansible.builtin.unarchive:
        src: "https://artifacts.internal.corp/prometheus/node_exporter-{{ node_exporter_version }}.linux-amd64.tar.gz"
        dest: /opt
        remote_src: true
        creates: "/opt/node_exporter-{{ node_exporter_version }}.linux-amd64/node_exporter"

    - name: Install node_exporter unit
      ansible.builtin.template:
        src: templates/node_exporter.service.j2
        dest: /etc/systemd/system/node_exporter.service
        mode: "0644"
      notify: restart node_exporter

    - name: Enable node_exporter
      ansible.builtin.systemd:
        name: node_exporter
        enabled: true
        state: started
        daemon_reload: true

    - name: Configure the Vault agent on hosts that need it
      ansible.builtin.include_role:
        name: vault_agent
      when: "'vault' in group_names or 'monitoring' in group_names"

    - name: Record the bootstrap in the MOTD so the next person knows who to blame
      ansible.builtin.copy:
        dest: /etc/motd
        mode: "0644"
        content: |
          {{ inventory_hostname }} — atlas-infra support host
          bootstrapped {{ ansible_date_time.iso8601 }} by {{ lookup('env', 'USER') }} (OPS-2210)
          kube context: {{ kube_context | default('none') }}

  handlers:
    - name: restart sshd
      ansible.builtin.service:
        name: ssh
        state: restarted

    - name: restart node_exporter
      ansible.builtin.systemd:
        name: node_exporter
        state: restarted
`;

SRC.PROD_INVENTORY = `; ansible/inventory/prod.ini — support hosts for the prod account.
; EKS nodes are not here and must not be added. See the playbook header.

[bastion]
bastion-01 ansible_host=10.40.128.11 kube_context=atlas-prod-eu-central-1
bastion-02 ansible_host=10.40.129.11 kube_context=atlas-prod-eu-central-1

[vault]
vault-01 ansible_host=10.40.130.21 vault_node_id=vault-01
vault-02 ansible_host=10.40.131.21 vault_node_id=vault-02
vault-03 ansible_host=10.40.132.21 vault_node_id=vault-03

[monitoring]
monitoring-01 ansible_host=10.40.133.31 prometheus_retention=30d

[support_hosts:children]
bastion
vault
monitoring

[support_hosts:vars]
ansible_user=ops
ansible_ssh_private_key_file=~/.ssh/atlas-prod-ops
ansible_python_interpreter=/usr/bin/python3
ansible_ssh_common_args=-o ProxyJump=ops@bastion-01.internal.corp
environment_name=prod
aws_region=eu-central-1

[bastion:vars]
; the bastion is its own jump host; going through itself confuses it
ansible_ssh_common_args=
`;

/* ---------- scripts ---------- */

SRC.ROTATE_CERTS = `#!/usr/bin/env bash
# scripts/rotate-certs.sh — reissue the internal TLS certificate for one
# hostname from Vault's PKI engine and roll it into the cluster.
#
# Usage: scripts/rotate-certs.sh <hostname> [namespace] [secret-name]
#
# Requires: vault (logged in), kubectl (context set), jq, openssl. Run from
# the bastion. Certs are valid for 30 days; the cron job on monitoring-01
# runs this weekly, so a failure here has three chances before anyone notices.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <hostname> [namespace] [secret-name]" >&2
  exit 64
fi
HOST=$1
NAMESPACE=platform-prod
SECRET=""
if [ "$#" -ge 2 ]; then NAMESPACE=$2; fi
if [ "$#" -ge 3 ]; then SECRET=$3; fi
if [ -z "$SECRET" ]; then SECRET="tls-$(echo "$HOST" | tr '.' '-')"; fi

VAULT_ADDR=https://vault.internal.corp:8200
export VAULT_ADDR
PKI_ROLE=platform-internal
TTL=720h
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

log() { printf '%s rotate-certs: %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || { log "missing dependency: $1"; exit 1; }
}
require vault
require kubectl
require jq
require openssl

log "issuing certificate for $HOST (ttl $TTL) via pki/$PKI_ROLE"
vault write -format=json "pki/issue/$PKI_ROLE" \\
  common_name="$HOST" \\
  alt_names="$HOST,$HOST.svc.cluster.local" \\
  ttl="$TTL" > "$WORKDIR/issue.json"

jq -r '.data.certificate' "$WORKDIR/issue.json" > "$WORKDIR/tls.crt"
jq -r '.data.issuing_ca' "$WORKDIR/issue.json" >> "$WORKDIR/tls.crt"
jq -r '.data.private_key' "$WORKDIR/issue.json" > "$WORKDIR/tls.key"
SERIAL=$(jq -r '.data.serial_number' "$WORKDIR/issue.json")

# Sanity: the cert must actually be for the host we asked for. Vault has
# never got this wrong. We check anyway, because "never" is a big word.
if ! openssl x509 -in "$WORKDIR/tls.crt" -noout -subject | grep -q "CN *= *$HOST"; then
  log "issued certificate subject does not match $HOST; refusing to install"
  exit 1
fi

log "installing secret $NAMESPACE/$SECRET"
kubectl -n "$NAMESPACE" create secret tls "$SECRET" \\
  --cert="$WORKDIR/tls.crt" --key="$WORKDIR/tls.key" \\
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" annotate secret "$SECRET" --overwrite \\
  "platform.internal/vault-serial=$SERIAL" \\
  "platform.internal/rotated-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null

# Anything mounting the secret needs a nudge. ingress-nginx reloads on its
# own; the gateway does not, and the gateway is the one people notice.
for DEPLOY in $(kubectl -n "$NAMESPACE" get deploy -l "platform.internal/tls-secret=$SECRET" -o name); do
  log "restarting $DEPLOY"
  kubectl -n "$NAMESPACE" rollout restart "$DEPLOY"
  kubectl -n "$NAMESPACE" rollout status "$DEPLOY" --timeout=5m
done

NOT_AFTER=$(openssl x509 -in "$WORKDIR/tls.crt" -noout -enddate | cut -d= -f2)
log "done: $HOST serial $SERIAL valid until $NOT_AFTER"
`;

SRC.DRAIN_NODE = `#!/usr/bin/env bash
# scripts/drain-node.sh — cordon and drain one EKS node, wait for its pods to
# land elsewhere, and optionally terminate the instance so the node group
# replaces it with a fresh AMI.
#
# Usage: scripts/drain-node.sh <node-name> [--terminate] [--grace SECONDS]
#
# Used during OPS-2210 to roll nodes one at a time when the managed node
# group's own rollout is too eager (25% at once is a lot of billing pods).
set -euo pipefail

NODE=""
TERMINATE=0
GRACE=120
while [ "$#" -gt 0 ]; do
  case "$1" in
    --terminate) TERMINATE=1 ;;
    --grace) shift; GRACE=$1 ;;
    -h|--help) echo "usage: $0 <node-name> [--terminate] [--grace SECONDS]"; exit 0 ;;
    *) NODE=$1 ;;
  esac
  shift
done
if [ -z "$NODE" ]; then
  echo "usage: $0 <node-name> [--terminate] [--grace SECONDS]" >&2
  exit 64
fi

log() { printf '%s drain-node: %s\\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

CONTEXT=$(kubectl config current-context)
case "$CONTEXT" in
  atlas-prod-*) log "context $CONTEXT is production; you have 5 seconds to regret this"; sleep 5 ;;
esac

if ! kubectl get node "$NODE" >/dev/null 2>&1; then
  log "node $NODE not found in $CONTEXT"
  exit 1
fi

INSTANCE_ID=$(kubectl get node "$NODE" -o jsonpath='{.spec.providerID}' | awk -F/ '{print $NF}')
NODE_GROUP=$(kubectl get node "$NODE" -o jsonpath='{.metadata.labels.eks\\.amazonaws\\.com/nodegroup}')
log "node $NODE instance=$INSTANCE_ID nodegroup=$NODE_GROUP"

# Refuse if the PDBs cannot tolerate it. kubectl drain would tell us too,
# but only after cordoning, and an uncordon at 03:00 is easy to forget.
BLOCKED=$(kubectl get pdb -A -o json | jq -r '.items[] | select(.status.disruptionsAllowed == 0) | "\\(.metadata.namespace)/\\(.metadata.name)"')
if [ -n "$BLOCKED" ]; then
  log "these PDBs allow zero disruptions right now; fix them first:"
  echo "$BLOCKED" >&2
  exit 2
fi

log "cordoning $NODE"
kubectl cordon "$NODE"

log "draining $NODE (grace $GRACE s)"
kubectl drain "$NODE" \\
  --ignore-daemonsets \\
  --delete-emptydir-data \\
  --grace-period="$GRACE" \\
  --timeout=15m \\
  --skip-wait-for-delete-timeout=60

# Wait until nothing but daemonsets remains. drain returns early sometimes,
# usually when a pod has a preStop hook that takes its time about it.
for i in $(seq 1 30); do
  REMAINING=$(kubectl get pods -A --field-selector "spec.nodeName=$NODE" -o json \\
    | jq '[.items[] | select(.metadata.ownerReferences[0].kind != "DaemonSet")] | length')
  if [ "$REMAINING" -eq 0 ]; then
    break
  fi
  log "waiting for $REMAINING pod(s) to leave ($i/30)"
  sleep 10
done

if [ "$TERMINATE" -eq 1 ]; then
  log "terminating $INSTANCE_ID; node group $NODE_GROUP will replace it"
  aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" >/dev/null
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID"
  log "terminated; a new node should join within ~4 minutes: kubectl get nodes -l eks.amazonaws.com/nodegroup=$NODE_GROUP -w"
else
  log "drained; node stays cordoned. Undo with: kubectl uncordon $NODE"
fi
`;

/* ---------- monitoring & docs ---------- */

SRC.PROM_RULES = `# monitoring/prometheus/rules/platform.rules.yml
# Loaded by the kube-prometheus-stack release in the monitoring namespace.
# Every alert has a runbook link. An alert without a runbook is a riddle
# delivered at 03:00, and we have stopped accepting those.
groups:
  - name: platform.availability
    interval: 30s
    rules:
      - alert: PlatformDeploymentUnavailable
        expr: |
          kube_deployment_status_replicas_available{namespace="platform-prod"}
            < kube_deployment_spec_replicas{namespace="platform-prod"} * 0.5
        for: 5m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "{{ $labels.deployment }} has fewer than half its replicas available"
          description: "{{ $value }} available in {{ $labels.namespace }}; check rollout status and PDBs."
          runbook_url: https://gitlab.internal.corp/platform/atlas-infra/-/blob/main/docs/runbooks/eks-upgrade.md#stuck-rollouts

      - alert: PlatformGatewayErrorRate
        expr: |
          sum(rate(http_requests_total{namespace="platform-prod", app="gateway", status=~"5.."}[5m]))
            / sum(rate(http_requests_total{namespace="platform-prod", app="gateway"}[5m])) > 0.02
        for: 10m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "gateway 5xx rate above 2% for 10 minutes"
          description: "Current rate {{ $value | humanizePercentage }}. Upstream timeouts first, then auth."

      - alert: PlatformPodCrashLooping
        expr: increase(kube_pod_container_status_restarts_total{namespace="platform-prod"}[15m]) > 3
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "{{ $labels.pod }} restarted {{ $value }} times in 15m"

  - name: platform.capacity
    rules:
      - alert: NodeGroupNearMaxSize
        expr: |
          atlas:nodegroup_ready_nodes >= on (label_eks_amazonaws_com_nodegroup) atlas_nodegroup_max_size - 1
        for: 30m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "node group {{ $labels.label_eks_amazonaws_com_nodegroup }} is one node from max_size"
          description: "Raise max_size in terraform/environments/prod/main.tf, or ask billing why it needs eleven pods."

      - alert: PersistentVolumeFillingUp
        expr: |
          predict_linear(kubelet_volume_stats_available_bytes{namespace="platform-prod"}[6h], 24 * 3600) < 0
        for: 1h
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "{{ $labels.persistentvolumeclaim }} will be full within 24h at the current rate"

      - record: atlas:nodegroup_ready_nodes
        expr: |
          sum by (label_eks_amazonaws_com_nodegroup) (
            kube_node_status_condition{condition="Ready", status="true"}
              * on (node) group_left(label_eks_amazonaws_com_nodegroup) kube_node_labels
          )

  - name: eks.upgrade
    # OPS-2210: these only matter during an upgrade window and are silenced by
    # the upgrade runbook's first step. If they fire outside a window, somebody
    # skipped the runbook.
    rules:
      - alert: EKSNodeVersionSkew
        expr: count(count by (kubelet_version) (kube_node_info)) > 1
        for: 6h
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "nodes are running more than one kubelet version for 6h"
          description: "Node group rollout stalled? scripts/drain-node.sh the stragglers. See the runbook."

      - alert: EKSControlPlaneVersionSkew
        expr: |
          (max(kube_node_info{kubelet_version=~"v1.30.*"}) > 0)
            and on () (kubernetes_build_info{job="apiserver", git_version=~"v1.31.*"} > 0)
        for: 24h
        labels:
          severity: info
          team: platform
        annotations:
          summary: "control plane is 1.31 but 1.30 kubelets remain after 24h"

      - alert: TerraformDriftDetected
        expr: atlasctl_drift_findings_total{env="prod", severity=~"warn|critical"} > 0
        for: 15m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "atlasctl found {{ $value }} drifted resource(s) in prod"
          description: "Someone clicked in the console. Run terraform plan before they click again."
          runbook_url: https://gitlab.internal.corp/platform/atlas-infra/-/blob/main/docs/runbooks/eks-upgrade.md#drift
`;

SRC.RUNBOOK = `# Runbook: EKS minor version upgrade (OPS-2210)

Upgrading atlas-prod from 1.30 to 1.31. This runbook is written for the
person doing it at 07:00 on a Tuesday with a coffee, and for the person
reading it at 03:00 on a Wednesday without one.

Estimated duration: 3-4 hours. Control plane 25 minutes, node groups
roughly 40 minutes each, the rest is waiting and looking at graphs.

## Before you start

1. Silence the eks.upgrade alert group for 6 hours in Alertmanager
   (monitoring/prometheus/rules/platform.rules.yml). The alerts are right;
   they are also not news.
2. Confirm there is no drift. Drift means the state file and the account
   disagree, and an upgrade is not the moment to find out which one is lying.

       bin/atlasctl drift --env prod

   Exit code 0: carry on. Exit code 3: stop, run terraform plan, fix the
   drift, come back.
3. Check the deprecated API report from the last staging run. 1.31 removes
   nothing we use, but the report exists for the version that will.
4. Confirm staging is already on 1.31 and has been for a week. If it has not,
   you are on the wrong environment.
5. Post in #platform-ops: "starting OPS-2210 prod control plane upgrade".
   Nobody will reply. Post anyway.

## Step 1: addons first

Bump addon_versions (terraform/modules/eks/variables.tf, overridden per
environment) to the versions in the 1.31 compatibility table. Apply. coredns
and kube-proxy roll on their own; vpc-cni takes a minute per node.

    make plan ENV=prod
    # review: only aws_eks_addon.this[...] should change
    CI=true make apply ENV=prod

## Step 2: control plane

Set eks_version = "1.31" in terraform/environments/prod/variables.tf. The
plan must show exactly one change: aws_eks_cluster.this version. Anything
else in the plan is drift you missed in "Before you start".

    make plan ENV=prod
    CI=true make apply ENV=prod        # ~25 minutes; the apply looks hung. It is not.

The API server stays available throughout. Watch:

    watch -n 30 'kubectl version; kubectl get nodes'

## Step 3: node groups, one at a time

The module sets max_unavailable_percentage = 25. For the platform node group
that is three nodes at once, which the PDBs tolerate. For batch it is five,
which nobody cares about.

Set node_release_version to the 1.31 AMI release and apply. The managed node
group rollout does the cordon/drain dance itself. When it stalls (it stalls
on the pod with the 20 minute preStop hook, every time):

    scripts/drain-node.sh ip-10-40-12-34.eu-central-1.compute.internal --terminate

Then wait for the replacement and check that every service is fully rolled
out before the next group:

    for d in gateway auth billing notifier scheduler search; do
      bin/atlasctl rollout status platform-$d -n platform-prod
    done

## Step 4: verify

- kubectl get nodes: every kubelet is v1.31.x. The EKSNodeVersionSkew alert
  clears on its own within the silence window.
- bin/atlasctl drift --env prod: clean.
- Grafana "Platform / Overview": error rate flat, p99 back where it was.
- Argo CD: every application Synced and Healthy. OutOfSync on the platform
  app after an upgrade is almost always the vault-agent-injector webhook
  caBundle; a sync fixes it.

Remove the Alertmanager silence. Post in #platform-ops. Update the
"last upgraded" line in README.md.

## Stuck rollouts

A Deployment stuck at N-1 available for more than ten minutes during a node
rollout is usually one of:

- A PDB with minAvailable equal to replicas. Check helm/platform/values.yaml;
  scheduler is the usual suspect because it has one replica and a PDB of 0,
  which is fine, until someone "fixes" it.
- A pod stuck Terminating because its preStop hook is waiting on a queue
  that will never drain. kubectl delete pod --grace-period=30. Yes, really.
- An HPA scaling down while the rollout scales up. Wait it out.

## Drift

atlasctl exit code 3 means the state file and AWS disagree on a tracked
attribute. Do not "fix" it in the console. Either:

- the console change was right: change the .tf to match and apply, or
- the console change was wrong: apply the .tf as-is, which reverts it.

Either way, find out who made the change. Not to blame them. To ask why the
change was needed and whether it should have been in terraform all along.

## Rolling back

There is no control plane rollback. EKS does not downgrade. If 1.31 breaks
something, the fix goes forward. Node groups can be rolled back to the
previous release_version (it is in the state history), which is why we
upgrade nodes last and one group at a time.
`;

/* ---------- build & packaging ---------- */

SRC.GO_MOD = `module gitlab.internal.corp/platform/atlas-infra

go 1.23

require (
	github.com/aws/aws-sdk-go-v2 v1.30.5
	github.com/aws/aws-sdk-go-v2/config v1.27.33
	github.com/aws/aws-sdk-go-v2/service/eks v1.48.2
	github.com/aws/aws-sdk-go-v2/service/rds v1.82.3
	github.com/aws/aws-sdk-go-v2/service/s3 v1.61.2
	github.com/aws/aws-sdk-go-v2/service/sts v1.30.7
	github.com/aws/smithy-go v1.20.4
	github.com/spf13/cobra v1.8.1
	k8s.io/api v0.31.1
	k8s.io/apimachinery v0.31.1
	k8s.io/client-go v0.31.1
)

require (
	github.com/aws/aws-sdk-go-v2/credentials v1.17.32 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.16.13 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.3.17 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.22.7 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.26.7 // indirect
	github.com/google/gofuzz v1.2.0 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/spf13/pflag v1.0.5 // indirect
	golang.org/x/net v0.29.0 // indirect
	golang.org/x/oauth2 v0.23.0 // indirect
	golang.org/x/time v0.6.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	k8s.io/klog/v2 v2.130.1 // indirect
	sigs.k8s.io/structured-merge-diff/v4 v4.4.1 // indirect
)
`;

SRC.MAKEFILE = `# atlas-infra — entry points. "make drift" before touching prod, "make plan"
# before "make apply", and "make apply" only from CI unless it is that kind
# of day.

.PHONY: build test lint drift plan apply helm-template helm-lint ansible-check image clean

ENV ?= staging
TF_DIR = terraform/environments/$(ENV)
VERSION ?= $(shell git describe --tags --always --dirty)
COMMIT ?= $(shell git rev-parse --short HEAD)
DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS = -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.date=$(DATE)
IMAGE = registry.internal.corp/platform/atlasctl

build:
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o bin/atlasctl ./cmd/atlasctl

test:
	go test ./... -race -count=1 -cover

lint:
	golangci-lint run ./...
	tflint --recursive --config "$(PWD)/.tflint.hcl"
	terraform fmt -check -recursive terraform

drift: build
	bin/atlasctl drift --env $(ENV) --dry-run

plan:
	terraform -chdir=$(TF_DIR) init -input=false
	terraform -chdir=$(TF_DIR) validate
	terraform -chdir=$(TF_DIR) plan -input=false -out=tfplan

apply:
	@test "$(CI)" = "true" || { echo "apply runs from CI. If you must: CI=true make apply ENV=$(ENV)"; exit 1; }
	terraform -chdir=$(TF_DIR) apply -input=false tfplan

helm-template:
	helm template platform helm/platform -f helm/platform/values.yaml -n platform-$(ENV)

helm-lint:
	helm lint helm/platform --strict

ansible-check:
	ansible-playbook -i ansible/inventory/$(ENV).ini ansible/playbooks/bootstrap-nodes.yml --check --diff

image:
	docker build --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) -t $(IMAGE):$(VERSION) .

clean:
	rm -rf bin $(TF_DIR)/tfplan $(TF_DIR)/.terraform
`;

SRC.DOCKERFILE = `# atlasctl runtime image. Two stages: one that has Go, one that has nothing
# but the binary and a CA bundle. The second one is the one that ships.
FROM registry.internal.corp/base/golang:1.23-bookworm AS build

ARG VERSION=dev
ARG COMMIT=none
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 GOOS=linux go build \\
    -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT -X main.date=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
    -o /out/atlasctl ./cmd/atlasctl

FROM registry.internal.corp/base/distroless-static:nonroot

COPY --from=build /out/atlasctl /usr/local/bin/atlasctl
# The CI job mounts kubeconfig and AWS creds at runtime; nothing is baked in,
# which the security review confirmed twice and will confirm again.
USER nonroot:nonroot
ENTRYPOINT ["atlasctl"]
CMD ["drift", "--env", "staging", "--format", "json"]
`;

SRC.GITLAB_CI = `# .gitlab-ci.yml — atlas-infra
#
# lint -> test -> plan -> apply -> image. plan runs on every MR against
# staging and prod; apply runs on main only: staging automatically, prod
# behind a manual gate that two people have to click. It used to be one.

stages:
  - lint
  - test
  - plan
  - apply
  - image

variables:
  GO_VERSION: "1.23"
  TF_VERSION: "1.9.5"
  TF_IN_AUTOMATION: "true"
  TF_INPUT: "0"
  AWS_REGION: eu-central-1
  GOFLAGS: "-mod=readonly"

default:
  tags: [platform-runner]
  interruptible: true

.go:
  image: registry.internal.corp/base/golang:$GO_VERSION-bookworm
  cache:
    key: go-mod
    paths: [.go/pkg/mod]
  variables:
    GOPATH: $CI_PROJECT_DIR/.go

.terraform:
  image: registry.internal.corp/base/terraform:$TF_VERSION
  before_script:
    - terraform -chdir=terraform/environments/$ENV init -backend-config="role_arn=$TF_ROLE_ARN"

golangci-lint:
  stage: lint
  extends: .go
  script:
    - golangci-lint run ./... --timeout 5m

tflint:
  stage: lint
  image: registry.internal.corp/base/tflint:0.53
  script:
    - tflint --init
    - tflint --recursive --format compact
    - terraform fmt -check -recursive terraform

helm-lint:
  stage: lint
  image: registry.internal.corp/base/helm:3.16
  script:
    - helm lint helm/platform --strict
    - helm template platform helm/platform -n platform-prod | kubeconform -strict -kubernetes-version 1.31.0

ansible-lint:
  stage: lint
  image: registry.internal.corp/base/ansible:10
  script:
    - ansible-lint ansible/playbooks
  allow_failure: true # ansible-lint has opinions about our opinions

go-test:
  stage: test
  extends: .go
  script:
    - go test ./... -race -count=1 -coverprofile=coverage.out
    - go tool cover -func=coverage.out | tail -1
  coverage: '/total:\\s+\\(statements\\)\\s+(\\d+\\.\\d+)%/'
  artifacts:
    paths: [coverage.out]
    expire_in: 1 week

.plan:
  stage: plan
  extends: .terraform
  script:
    - terraform -chdir=terraform/environments/$ENV validate
    - terraform -chdir=terraform/environments/$ENV plan -out=tfplan -detailed-exitcode || PLAN_EXIT=$?
    - terraform -chdir=terraform/environments/$ENV show -no-color tfplan > plan-$ENV.txt
  artifacts:
    paths:
      - terraform/environments/$ENV/tfplan
      - plan-$ENV.txt
    expire_in: 2 days
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == "main"

plan:staging:
  extends: .plan
  variables: { ENV: staging }

plan:prod:
  extends: .plan
  variables: { ENV: prod }

drift:prod:
  stage: plan
  image: $CI_REGISTRY_IMAGE/atlasctl:latest
  script:
    - atlasctl drift --env prod --format markdown | tee drift-prod.md
  artifacts:
    paths: [drift-prod.md]
    when: always
  allow_failure:
    exit_codes: [3] # drift is a finding, not a failure; see cmd/atlasctl/main.go
  rules:
    - if: $CI_COMMIT_BRANCH == "main"

apply:staging:
  stage: apply
  extends: .terraform
  variables: { ENV: staging }
  script:
    - terraform -chdir=terraform/environments/staging apply -auto-approve tfplan
  needs: [plan:staging, go-test]
  environment: { name: staging }
  rules:
    - if: $CI_COMMIT_BRANCH == "main"

apply:prod:
  stage: apply
  extends: .terraform
  variables: { ENV: prod }
  script:
    - terraform -chdir=terraform/environments/prod apply -auto-approve tfplan
  needs: [plan:prod, apply:staging]
  environment: { name: production }
  resource_group: prod-terraform
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
      when: manual

image:
  stage: image
  image: registry.internal.corp/base/kaniko:1.23
  script:
    - /kaniko/executor --context $CI_PROJECT_DIR --dockerfile Dockerfile
      --destination $CI_REGISTRY_IMAGE/atlasctl:$CI_COMMIT_SHORT_SHA
      --destination $CI_REGISTRY_IMAGE/atlasctl:latest
      --build-arg VERSION=$CI_COMMIT_TAG --build-arg COMMIT=$CI_COMMIT_SHORT_SHA
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
    - if: $CI_COMMIT_TAG
`;

/* ---------- tests ---------- */

SRC.DETECTOR_TEST = `package drift

import (
    "context"
    "errors"
    "strings"
    "testing"
    "time"

    "gitlab.internal.corp/platform/atlas-infra/internal/aws"
)

// fakeFetcher serves a canned state file and canned live attributes. It is
// the whole of AWS, as far as these tests are concerned.
type fakeFetcher struct {
    state []byte
    live  map[string]map[string]string // keyed by resource id
    errs  map[string]error
    calls []string
}

func (f *fakeFetcher) GetObject(_ context.Context, bucket, key string) ([]byte, error) {
    f.calls = append(f.calls, "get "+bucket+"/"+key)
    if f.state == nil {
        return nil, errors.New("no state")
    }
    return f.state, nil
}

func (f *fakeFetcher) DescribeResource(_ context.Context, rtype, id string) (map[string]string, error) {
    f.calls = append(f.calls, "describe "+rtype+" "+id)
    if err, ok := f.errs[id]; ok {
        return nil, err
    }
    attrs, ok := f.live[id]
    if !ok {
        return nil, aws.ErrNotFound
    }
    return attrs, nil
}

// fixtureState is written with single quotes and swapped to double quotes,
// because a state file full of escaped quotes is the kind of test nobody reads.
var fixtureState = []byte(strings.ReplaceAll(strings.Join([]string{
    "{'version': 4, 'serial': 812, 'resources': [",
    " {'mode': 'managed', 'type': 'aws_eks_cluster', 'name': 'this', 'module': 'module.eks',",
    "  'instances': [{'attributes': {'id': 'atlas-prod', 'version': '1.31', 'endpoint_public_access': false}}]},",
    " {'mode': 'managed', 'type': 'aws_eks_node_group', 'name': 'this', 'module': 'module.eks',",
    "  'instances': [{'attributes': {'id': 'atlas-prod:platform', 'release_version': '1.31.0-20240910',",
    "   'scaling_config': [{'desired_size': 6, 'max_size': 12}], 'instance_types': ['m6i.xlarge']}}]},",
    " {'mode': 'managed', 'type': 'aws_db_instance', 'name': 'main',",
    "  'instances': [{'attributes': {'id': 'atlas-prod-main', 'engine_version': '16.3', 'instance_class': 'db.r6g.large',",
    "   'deletion_protection': true, 'multi_az': true}}]},",
    " {'mode': 'data', 'type': 'aws_caller_identity', 'name': 'current', 'instances': [{'attributes': {'id': '123456789012'}}]}",
    "]}",
}, ""), "'", "\\""))

func liveClean() map[string]map[string]string {
    return map[string]map[string]string{
        "atlas-prod":          {"version": "1.31", "endpoint_public_access": "false"},
        "atlas-prod:platform": {"release_version": "1.31.0-20240910", "scaling_config.0.desired_size": "6", "scaling_config.0.max_size": "12", "instance_types.0": "m6i.xlarge"},
        "atlas-prod-main":     {"engine_version": "16.3", "instance_class": "db.r6g.large", "deletion_protection": "true", "multi_az": "true"},
    }
}

func newTestDetector(f *fakeFetcher, include ...string) *Detector {
    d := NewDetector(f, Config{Env: "test", StateBucket: "b", StateKey: "k", Include: include})
    d.now = func() time.Time { return time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC) }
    return d
}

func TestRunReportsNoDriftWhenLiveMatchesState(t *testing.T) {
    f := &fakeFetcher{state: fixtureState, live: liveClean()}
    report, err := newTestDetector(f).Run(context.Background())
    if err != nil {
        t.Fatal(err)
    }
    if report.HasDrift() {
        t.Fatalf("expected no drift, got %d drifted findings", report.DriftedCount())
    }
    if len(report.Findings) != 3 {
        t.Fatalf("expected 3 managed resources checked, got %d", len(report.Findings))
    }
    if report.StateSerial != 812 {
        t.Errorf("serial: got %d", report.StateSerial)
    }
}

func TestRunSkipsDataSources(t *testing.T) {
    f := &fakeFetcher{state: fixtureState, live: liveClean()}
    if _, err := newTestDetector(f).Run(context.Background()); err != nil {
        t.Fatal(err)
    }
    for _, c := range f.calls {
        if strings.Contains(c, "aws_caller_identity") {
            t.Fatalf("data source was described: %s", c)
        }
    }
}

func TestDesiredSizeDriftIsInfo(t *testing.T) {
    live := liveClean()
    live["atlas-prod:platform"]["scaling_config.0.desired_size"] = "9" // the autoscaler had a busy afternoon
    f := &fakeFetcher{state: fixtureState, live: live}
    report, err := newTestDetector(f, "aws_eks_node_group").Run(context.Background())
    if err != nil {
        t.Fatal(err)
    }
    if got := report.Worst(); got != SeverityInfo {
        t.Fatalf("worst severity: got %s, want info", got)
    }
    if report.DriftedCount() != 1 || len(report.Findings[0].Diffs) != 1 {
        t.Fatalf("expected exactly one diff, got %+v", report.Findings)
    }
}

func TestDeletionProtectionDriftIsCritical(t *testing.T) {
    live := liveClean()
    live["atlas-prod-main"]["deletion_protection"] = "false"
    f := &fakeFetcher{state: fixtureState, live: live}
    report, err := newTestDetector(f).Run(context.Background())
    if err != nil {
        t.Fatal(err)
    }
    if report.Worst() != SeverityCritical {
        t.Fatalf("worst: got %s", report.Worst())
    }
    if report.Findings[0].Address != "aws_db_instance.main" {
        t.Fatalf("critical finding should sort first, got %s", report.Findings[0].Address)
    }
}

func TestMissingResourceIsCriticalNotError(t *testing.T) {
    live := liveClean()
    delete(live, "atlas-prod-main")
    f := &fakeFetcher{state: fixtureState, live: live}
    report, err := newTestDetector(f).Run(context.Background())
    if err != nil {
        t.Fatal(err)
    }
    if len(report.Errors) != 0 {
        t.Fatalf("not-found should be a finding, got errors %v", report.Errors)
    }
    if report.Findings[0].Severity != SeverityCritical || !strings.Contains(report.Findings[0].Note, "not in AWS") {
        t.Fatalf("unexpected finding: %+v", report.Findings[0])
    }
}

func TestDescribeErrorsAreCollectedNotFatal(t *testing.T) {
    f := &fakeFetcher{state: fixtureState, live: liveClean(), errs: map[string]error{"atlas-prod": errors.New("throttled")}}
    report, err := newTestDetector(f).Run(context.Background())
    if err != nil {
        t.Fatal(err)
    }
    if len(report.Errors) != 1 || !strings.Contains(report.Errors[0], "throttled") {
        t.Fatalf("errors: %v", report.Errors)
    }
    if len(report.Findings) != 2 {
        t.Fatalf("the other resources should still be checked, got %d", len(report.Findings))
    }
}

func TestRejectsOldStateVersion(t *testing.T) {
    f := &fakeFetcher{state: []byte("{\\"version\\": 3, \\"resources\\": []}")}
    _, err := newTestDetector(f).Run(context.Background())
    if err == nil || !strings.Contains(err.Error(), "unsupported state version") {
        t.Fatalf("expected version error, got %v", err)
    }
}

func TestFlattenNestedPaths(t *testing.T) {
    attrs := map[string]any{
        "scaling_config": []any{map[string]any{"desired_size": float64(6)}},
        "tags":           map[string]any{"Owner": "platform-team"},
        "multi_az":       true,
    }
    cases := map[string]string{
        "scaling_config.0.desired_size": "6",
        "scaling_config.1.desired_size": "",
        "tags.Owner":                    "platform-team",
        "multi_az":                      "true",
        "nope":                          "",
    }
    for path, want := range cases {
        if got := flatten(attrs, path); got != want {
            t.Errorf("flatten(%q) = %q, want %q", path, got, want)
        }
    }
}
`;

SRC.ROLLOUT_TEST = `package k8s

import (
    "bytes"
    "context"
    "errors"
    "strings"
    "testing"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes/fake"
)

func int32p(i int32) *int32 { return &i }

func deployment(name string, desired, updated, ready, available int32) *appsv1.Deployment {
    return &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "platform-prod", Generation: 4},
        Spec:       appsv1.DeploymentSpec{Replicas: int32p(desired)},
        Status: appsv1.DeploymentStatus{
            ObservedGeneration: 4,
            UpdatedReplicas:    updated,
            ReadyReplicas:      ready,
            AvailableReplicas:  available,
        },
    }
}

func TestStatusDoneWhenAllReplicasMatch(t *testing.T) {
    cs := fake.NewSimpleClientset(deployment("platform-gateway", 4, 4, 4, 4))
    st, err := GetStatus(context.Background(), cs, "platform-prod", "platform-gateway")
    if err != nil {
        t.Fatal(err)
    }
    if !st.Done() {
        t.Fatalf("expected done, got %s", st)
    }
}

func TestStatusNotDoneWhileGenerationLags(t *testing.T) {
    dep := deployment("platform-auth", 3, 3, 3, 3)
    dep.Generation = 5 // spec changed; the controller has not caught up yet
    cs := fake.NewSimpleClientset(dep)
    st, err := GetStatus(context.Background(), cs, "platform-prod", "platform-auth")
    if err != nil {
        t.Fatal(err)
    }
    if st.Done() {
        t.Fatalf("observedGeneration %d < generation %d should not be done", st.ObservedGeneration, st.Generation)
    }
}

func TestWaitForRolloutTimesOut(t *testing.T) {
    cs := fake.NewSimpleClientset(deployment("platform-billing", 2, 2, 1, 1))
    ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
    defer cancel()
    var log bytes.Buffer
    err := WaitForRollout(ctx, cs, "platform-prod", "platform-billing", WaitOptions{Poll: 10 * time.Millisecond, Log: &log})
    if !errors.Is(err, ErrTimeout) {
        t.Fatalf("expected ErrTimeout, got %v", err)
    }
    if !strings.Contains(log.String(), "ready=1") {
        t.Fatalf("progress should be logged once, got %q", log.String())
    }
}

func TestWaitForRolloutFailsFastOnProgressDeadline(t *testing.T) {
    dep := deployment("platform-search", 3, 1, 1, 1)
    dep.Status.Conditions = []appsv1.DeploymentCondition{{
        Type:   appsv1.DeploymentProgressing,
        Status: corev1.ConditionFalse,
        Reason: "ProgressDeadlineExceeded",
    }}
    cs := fake.NewSimpleClientset(dep)
    err := WaitForRollout(context.Background(), cs, "platform-prod", "platform-search", WaitOptions{Poll: time.Millisecond})
    if err == nil || !strings.Contains(err.Error(), "ProgressDeadlineExceeded") {
        t.Fatalf("expected a ProgressDeadlineExceeded error, got %v", err)
    }
}

func TestRestartPatchesTemplateAnnotation(t *testing.T) {
    cs := fake.NewSimpleClientset(deployment("platform-notifier", 2, 2, 2, 2))
    if err := Restart(context.Background(), cs, "platform-prod", "platform-notifier"); err != nil {
        t.Fatal(err)
    }
    dep, err := cs.AppsV1().Deployments("platform-prod").Get(context.Background(), "platform-notifier", metav1.GetOptions{})
    if err != nil {
        t.Fatal(err)
    }
    stamp := dep.Spec.Template.Annotations["atlasctl.platform.internal/restartedAt"]
    if _, err := time.Parse(time.RFC3339, stamp); err != nil {
        t.Fatalf("restartedAt annotation missing or not RFC3339: %q", stamp)
    }
}

func TestGetStatusWrapsNotFound(t *testing.T) {
    cs := fake.NewSimpleClientset()
    _, err := GetStatus(context.Background(), cs, "platform-prod", "platform-ghost")
    if err == nil || !strings.Contains(err.Error(), "platform-prod/platform-ghost") {
        t.Fatalf("error should name the deployment, got %v", err)
    }
}
`;

SRC.README = `# atlas-infra

Infrastructure monorepo for the platform team: the AWS accounts, the EKS
clusters that run the platform services, the Helm chart that deploys them,
the Ansible that bootstraps the handful of hosts EKS does not own, and
atlasctl, a small Go CLI that tells us when the state file and reality have
stopped talking to each other.

Last upgraded: atlas-staging 1.31 (2026-08-28). atlas-prod 1.30, OPS-2210 in progress.

## Layout

- terraform/environments/   one root module per account (staging, prod); remote state in S3
- terraform/modules/        vpc, eks, rds, redis, alb, waf, iam-ci, monitoring
- k8s/base, k8s/overlays/   kustomize base and per-environment overlays, synced by Argo CD
- helm/platform/            the platform chart: gateway, auth, billing, notifier, scheduler, search
- ansible/                  bootstrap for bastions, Vault nodes and the monitoring host
- monitoring/prometheus/    alert and recording rules, loaded by kube-prometheus-stack
- cmd/atlasctl, internal/   drift detector and rollout helpers (Go)
- scripts/                  the two scripts we kept after deleting the other forty
- docs/runbooks/            what to do when it pages you

## Working from the bastion

    ssh ops@bastion-01.internal.corp
    aws sso login --profile platform-prod
    aws sts get-caller-identity
    kubectl config use-context atlas-prod-eu-central-1
    make build && bin/atlasctl drift --env prod --dry-run

Port-forwards for the usual suspects: Prometheus :9090, Grafana :3000,
Argo CD :8080, Vault :8200. The API server is on :6443 through the tunnel
that ssh sets up for you, which is why it is not in any security group.

## Making a change

1. Branch from main with the ticket id: feature/OPS-2210-eks-upgrade.
2. make lint && make test. tflint and golangci-lint are both strict and both
   right more often than we would like.
3. Open an MR. CI runs terraform plan for staging and prod and attaches the
   plan output. Read the plan. The whole plan. "0 to destroy" is the line
   that matters, and it is at the bottom.
4. Merge. staging applies automatically; prod waits for a manual gate.
5. After a prod apply, run atlasctl drift. If it finds something, the apply
   did not do what the plan said, and that is a story for #platform-ops.

## Conventions

- No terraform apply from laptops. The Makefile enforces this and can be
  bypassed; the audit log cannot.
- Every node group, RDS instance and bucket has deletion protection or its
  equivalent. atlasctl treats drift on those flags as critical.
- Kubernetes changes go through Helm values or kustomize overlays, never
  kubectl edit. Argo CD will revert you within three minutes and will not
  say sorry.
- Runbooks live next to the alerts they explain. An alert with no runbook_url
  does not pass helm-lint, because we wrote a check for it.

## Deployment

Merges to main build registry.internal.corp/platform/atlasctl and push the
image tag used by the drift:prod CI job. The platform services themselves
are deployed by Argo CD from helm/platform; this repo owns the chart, the
service repos own the image tags via values-prod.yaml MRs.
`;

PROFILES.register({
  id: 'devops',
  label: 'DevOps & Cloud infrastructure',
  stack: 'Terraform · Kubernetes · Go · Ansible',
  desc: 'Platform infra monorepo: AWS EKS via Terraform, Helm charts, Ansible bootstrap and a Go CLI that detects config drift.',
  project: 'atlas-infra',
  version: '0.7.2',
  branch: 'feature/OPS-2210-eks-upgrade',
  remote: 'gitlab.internal.corp:platform/atlas-infra',
  image: 'registry.internal.corp/platform/atlasctl',
  deployName: 'platform-gateway',
  namespace: 'platform-prod',
  dbLine: null,
  migrateLines: [],
  primaryLang: 'hcl',
  checker: 'terraform validate',
  checkFiles: 61,
  termproc: 'bash — atlas-infra',
  hmrPath: null,
  shell: { user: 'ops', host: 'bastion-01', pkg: 'go' },
  ports: [
    [9090, 'Prometheus', 'prometheus'],
    [3000, 'Grafana', 'grafana'],
    [8080, 'Argo CD', 'argocd-server'],
    [8200, 'Vault', 'vault'],
    [6443, 'kube-apiserver (tunnel)', 'ssh'],
  ],
  scripts: [
    ['build', 'CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o bin/atlasctl ./cmd/atlasctl'],
    ['test', 'go test ./... -race -count=1 -cover'],
    ['lint', 'golangci-lint run ./... && tflint --recursive && terraform fmt -check -recursive terraform'],
    ['drift', 'bin/atlasctl drift --env prod --dry-run'],
    ['plan', 'terraform -chdir=terraform/environments/prod plan -input=false -out=tfplan'],
    ['helm-template', 'helm template platform helm/platform -f helm/platform/values.yaml -n platform-prod'],
  ],
  branches: [
    'main',
    'feature/OPS-2210-eks-upgrade',
    'feature/OPS-2204-drift-detector',
    'feature/OPS-2198-vault-agent-injector',
    'hotfix/OPS-2231-coredns-oom',
    'chore/OPS-2187-tflint-rules',
    'release/2026.09',
  ],
  commits: [
    ['4e1c9a2', 'feat(eks): validated cluster_version and pinned addon versions (OPS-2210)', 'Maren Lindqvist', '2 hours ago'],
    ['b83f0d1', 'feat(atlasctl): per-attribute drift severity, exit 3 on findings', 'Dev Bhattacharya', '4 hours ago'],
    ['9a07e5c', 'test(drift): fixture state with data sources and not-found resources', 'Dev Bhattacharya', '6 hours ago'],
    ['e2d4b17', 'chore(helm): topologySpreadConstraints for every service', 'Oskar Nowicki', 'yesterday'],
    ['57c1f8e', 'fix(scripts): drain-node refuses when a PDB allows zero disruptions', 'Maren Lindqvist', 'yesterday'],
    ['c6a92d0', 'docs(runbook): eks upgrade steps, stuck rollouts, rollback', 'Chiara Fontana', '2 days ago'],
    ['1f3b6e4', 'ci: prod apply behind a manual gate with resource_group', 'Oskar Nowicki', '2 days ago'],
    ['a90d2c7', 'feat(prometheus): eks.upgrade alert group and drift alert', 'Chiara Fontana', '3 days ago'],
    ['d48e7b3', 'refactor(aws): translate SDK not-found codes to ErrNotFound', 'Dev Bhattacharya', '4 days ago'],
    ['720c5f9', 'chore: bump terraform to 1.9.5, aws provider to 5.60', 'Maren Lindqvist', '5 days ago'],
  ],
  lintFiles: [
    ['terraform/modules/eks/main.tf', '101:1   Missing version constraint for provider "tls" in "required_providers"', 'terraform_required_providers'],
    ['terraform/environments/prod/variables.tf', '30:1    variable "rds_instance_class" is declared but not used', 'terraform_unused_declarations'],
    ['internal/aws/client.go', '76:21   Error return value of out.Body.Close is not checked', 'errcheck'],
    ['internal/drift/detector.go', '186:1   cyclomatic complexity 17 of func flatten is high (> 15)', 'gocyclo'],
    ['cmd/atlasctl/main.go', '158:24  unused-parameter: parameter "args" seems to be unused, consider removing or renaming it as _', 'revive'],
  ],
  suites: [
    ['internal/drift/detector_test.go', 7, 9],
    ['internal/k8s/rollout_test.go', 5, 7],
  ],
  jobs: ['terraform', 'ansible', 'packer', 'helm', 'kubectlapply', 'argocd', 'prometheus', 'vault', 'gobuild', 'gotest', 'golangci', 'gitfetch', 'docker', 'k8s'],
  bootLines: [
    '<span class="mag">$</span> aws sts get-caller-identity --output text',
    '<span class="dim">123456789012    arn:aws:sts::123456789012:assumed-role/platform-ops/ops    AROAEXAMPLEPLATFORM</span>',
    '<span class="mag">$</span> kubectl config current-context',
    '<span class="dim">atlas-prod-eu-central-1</span>',
    '<span class="mag">$</span> kubectl get nodes -l role=platform --no-headers | wc -l',
    '<span class="dim">6</span>',
    '<span class="mag">$</span> terraform -chdir=terraform/environments/prod init -input=false',
    '<span class="info">Terraform has been successfully initialized!</span>',
    '<span class="dim">tip: bin/atlasctl drift --env prod --dry-run before you plan</span>',
  ],
  debug: {
    conf: 'Launch atlasctl drift --dry-run',
    vars: [
      ['opts.env', '"prod"'],
      ['dryRun', 'true'],
      ['len(st.Resources)', '214'],
      ['report.DriftedCount()', '7'],
      ['report.Worst()', 'SeverityWarn (2)'],
    ],
    watch: [
      ['res.Type + "." + res.Name', '"aws_eks_node_group.this"'],
      ['finding.Diffs[0]', '{scaling_config.0.desired_size 6 9}'],
      ['d.now().Sub(started)', '4.21s'],
    ],
    stack: [
      '(*Detector).Compare  detector.go:118',
      '(*Detector).Run  detector.go:91',
      'newDriftCmd.func1  main.go:97',
      '(*cobra.Command).execute  command.go:985',
    ],
  },
  files: () => [
    ['terraform/environments/prod/main.tf', genLargeTerraform(SRC.PROD_MAIN, 'atlas', ['vpc', 'eks', 'nodegroup', 'rds', 'redis', 'alb', 'waf', 's3-artifacts', 'iam-ci', 'kms', 'cloudwatch', 'sqs'], 1000), true],
    ['k8s/base/platform.yaml', genLargeK8sManifests(SRC.PLATFORM_BASE, 'platform', ['gateway', 'auth', 'billing', 'notifier', 'scheduler', 'search'], 600), true],
    ['cmd/atlasctl/main.go', SRC.MAIN_GO, true],
    ['internal/drift/detector.go', SRC.DETECTOR_GO, true],
    ['internal/drift/report.go', SRC.REPORT_GO],
    ['internal/drift/detector_test.go', SRC.DETECTOR_TEST],
    ['internal/aws/client.go', SRC.AWS_CLIENT_GO],
    ['internal/k8s/rollout.go', SRC.ROLLOUT_GO, true],
    ['internal/k8s/rollout_test.go', SRC.ROLLOUT_TEST],
    ['terraform/modules/eks/main.tf', SRC.EKS_MAIN, true],
    ['terraform/modules/eks/variables.tf', SRC.EKS_VARIABLES],
    ['terraform/modules/eks/outputs.tf', SRC.EKS_OUTPUTS],
    ['terraform/environments/prod/variables.tf', SRC.PROD_VARIABLES],
    ['terraform/environments/prod/backend.tf', SRC.PROD_BACKEND],
    ['helm/platform/Chart.yaml', SRC.CHART_YAML],
    ['helm/platform/values.yaml', SRC.VALUES_YAML],
    ['helm/platform/templates/deployment.yaml', SRC.DEPLOYMENT_TPL],
    ['ansible/playbooks/bootstrap-nodes.yml', SRC.BOOTSTRAP_PLAYBOOK],
    ['ansible/inventory/prod.ini', SRC.PROD_INVENTORY],
    ['scripts/rotate-certs.sh', SRC.ROTATE_CERTS],
    ['scripts/drain-node.sh', SRC.DRAIN_NODE],
    ['monitoring/prometheus/rules/platform.rules.yml', SRC.PROM_RULES],
    ['docs/runbooks/eks-upgrade.md', SRC.RUNBOOK],
    ['go.mod', SRC.GO_MOD],
    ['Makefile', SRC.MAKEFILE],
    ['Dockerfile', SRC.DOCKERFILE],
    ['.gitlab-ci.yml', SRC.GITLAB_CI],
    ['README.md', SRC.README],
  ],
  tree: () => [
    d('.terraform', []),
    d('ansible', [
      d('inventory', [fnode('ansible/inventory/prod.ini')], true),
      d('playbooks', [fnode('ansible/playbooks/bootstrap-nodes.yml')], true),
    ], true),
    d('bin', []),
    d('cmd', [d('atlasctl', [fnode('cmd/atlasctl/main.go')], true)], true),
    d('docs', [d('runbooks', [fnode('docs/runbooks/eks-upgrade.md')], true)]),
    d('helm', [
      d('platform', [
        d('templates', [fnode('helm/platform/templates/deployment.yaml')], true),
        fnode('helm/platform/Chart.yaml'),
        fnode('helm/platform/values.yaml'),
      ], true),
    ], true),
    d('internal', [
      d('aws', [fnode('internal/aws/client.go')], true),
      d('drift', [
        fnode('internal/drift/detector.go'),
        fnode('internal/drift/detector_test.go'),
        fnode('internal/drift/report.go'),
      ], true),
      d('k8s', [fnode('internal/k8s/rollout.go'), fnode('internal/k8s/rollout_test.go')], true),
    ], true),
    d('k8s', [
      d('base', [fnode('k8s/base/platform.yaml')], true),
      d('overlays', [d('prod', []), d('staging', [])]),
    ], true),
    d('monitoring', [d('prometheus', [d('rules', [fnode('monitoring/prometheus/rules/platform.rules.yml')], true)], true)], true),
    d('scripts', [fnode('scripts/drain-node.sh'), fnode('scripts/rotate-certs.sh')], true),
    d('terraform', [
      d('environments', [
        d('prod', [
          fnode('terraform/environments/prod/backend.tf'),
          fnode('terraform/environments/prod/main.tf'),
          fnode('terraform/environments/prod/variables.tf'),
        ], true),
        d('staging', []),
      ], true),
      d('modules', [
        d('eks', [
          fnode('terraform/modules/eks/main.tf'),
          fnode('terraform/modules/eks/outputs.tf'),
          fnode('terraform/modules/eks/variables.tf'),
        ], true),
        d('monitoring', []),
        d('rds', []),
        d('vpc', []),
      ], true),
    ], true),
    fnode('.gitlab-ci.yml'), fnode('Dockerfile'), fnode('go.mod'), fnode('Makefile'), fnode('README.md'),
  ],
});
})();
