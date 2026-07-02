package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/mux"
	_ "github.com/jackc/pgx/v5/stdlib"
	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	waCompanionReg "go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

type Engine struct {
	container  *sqlstore.Container
	db         *sql.DB
	clients    map[string]*whatsmeow.Client
	connecting map[string]bool
	lastQR     map[string]string
	accountIDs map[string]int
	sessionWAs map[string]bool
	mu         sync.Mutex
	nodeURL    string
	token      string
	logLevel   string
}

func NewEngine() *Engine {
	deviceName := envOrDefault("ENGINE_DEVICE_NAME", "Wozapi2")
	store.SetOSInfo(deviceName, [3]uint32{2, 0, 0})
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
	store.DeviceProps.Os = proto.String(deviceName)
	store.DeviceProps.RequireFullSync = proto.Bool(true)
	store.BaseClientPayload.UserAgent.Manufacturer = proto.String(deviceName)
	store.BaseClientPayload.UserAgent.Device = proto.String(deviceName)
	store.BaseClientPayload.UserAgent.OsVersion = proto.String("2.0")
	_ = os.Setenv("WHATSMEOW_DEVICE_NAME", deviceName)

	logLevel := envOrDefault("ENGINE_LOG_LEVEL", "INFO")
	dbLog := waLog.Stdout("Database", "ERROR", true)

	databaseURL := os.Getenv("DATABASE_URL")
	var driverName string
	var dsn string
	if databaseURL != "" {
		driverName = "pgx"
		dsn = databaseURL
	} else {
		driverName = "sqlite"
		dbPath := envOrDefault("ENGINE_DB_PATH", "engine_v2.db")
		dsn = fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(15000)&_pragma=journal_mode(WAL)", dbPath)
	}

	container, err := sqlstore.New(context.Background(), driverName, dsn, dbLog)
	if err != nil {
		panic(err)
	}
	db, err := sql.Open(driverName, dsn)
	if err != nil {
		panic(err)
	}
	if driverName == "sqlite" {
		if _, err = db.Exec(`
			CREATE TABLE IF NOT EXISTS engine_sessions (
				session_name TEXT PRIMARY KEY,
				account_id INTEGER NOT NULL DEFAULT 0,
				jid TEXT NOT NULL DEFAULT '',
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)
		`); err != nil {
			panic(err)
		}
	} else {
		if _, err = db.Exec(`
			CREATE TABLE IF NOT EXISTS engine_sessions (
				session_name TEXT PRIMARY KEY,
				account_id INTEGER NOT NULL DEFAULT 0,
				jid TEXT NOT NULL DEFAULT '',
				created_at TIMESTAMPTZ DEFAULT NOW(),
				updated_at TIMESTAMPTZ DEFAULT NOW()
			)
		`); err != nil {
			panic(err)
		}
	}

	return &Engine{
		container:  container,
		db:         db,
		clients:    make(map[string]*whatsmeow.Client),
		connecting: make(map[string]bool),
		lastQR:     make(map[string]string),
		accountIDs: make(map[string]int),
		sessionWAs: make(map[string]bool),
		nodeURL:    envOrDefault("NODE_URL", "http://localhost:3000"),
		token:      envOrDefault("ENGINE_TOKEN", "dev-engine-token"),
		logLevel:   logLevel,
	}
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func (e *Engine) authorized(r *http.Request) bool {
	token := r.Header.Get("X-Engine-Token")
	if token == "" {
		token = r.Header.Get("X-Bridge-Token")
	}
	return token == e.token
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (e *Engine) getAccountID(session string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	if id, ok := e.accountIDs[session]; ok {
		return id
	}
	var accountID int
	err := e.db.QueryRow("SELECT account_id FROM engine_sessions WHERE session_name = ?", session).Scan(&accountID)
	if err == nil {
		e.accountIDs[session] = accountID
		return accountID
	}
	return 0
}

func sessionNameFromRequest(r *http.Request) string {
	return mux.Vars(r)["session"]
}

func phoneCandidates(user string) []string {
	digits := onlyDigits(user)
	if digits == "" {
		return nil
	}
	candidates := []string{"+" + digits}
	if strings.HasPrefix(digits, "55") && len(digits) == 13 {
		withoutNinth := digits[:4] + digits[5:]
		if withoutNinth != digits {
			candidates = append(candidates, "+"+withoutNinth)
		}
	} else if strings.HasPrefix(digits, "55") && len(digits) == 12 {
		withNinth := digits[:4] + "9" + digits[4:]
		if withNinth != digits {
			candidates = append(candidates, "+"+withNinth)
		}
	}
	return candidates
}

func onlyDigits(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r >= '0' && r <= '9' {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func resolveJID(session *whatsmeow.Client, jidText string) (types.JID, error) {
	target, err := types.ParseJID(strings.TrimSpace(jidText))
	if err != nil || target.User == "" {
		return types.JID{}, fmt.Errorf("invalid jid: %s", jidText)
	}
	if target.Server != types.LegacyUserServer && target.Server != types.DefaultUserServer {
		return target, nil
	}
	candidates := phoneCandidates(target.User)
	if len(candidates) == 0 {
		return target, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	resp, err := session.IsOnWhatsApp(ctx, candidates)
	if err != nil {
		return types.JID{}, fmt.Errorf("failed to validate recipient: %w", err)
	}
	for _, c := range candidates {
		normalized := strings.TrimPrefix(c, "+")
		for _, item := range resp {
			if item.IsIn && strings.TrimPrefix(item.Query, "+") == normalized && item.JID.User != "" {
				return item.JID, nil
			}
		}
	}
	return types.JID{}, fmt.Errorf("recipient is not registered on WhatsApp")
}

func main() {
	engine := NewEngine()
	r := mux.NewRouter()

	r.HandleFunc("/health", engine.handleHealth).Methods("GET")
	r.HandleFunc("/api/health", engine.handleHealth).Methods("GET")

	api := r.PathPrefix("/api").Subrouter()

	api.HandleFunc("/sessions", engine.handleListSessions).Methods("GET")
	api.HandleFunc("/sessions", engine.handleCreateSession).Methods("POST")

	api.HandleFunc("/sessions/{session}", engine.handleGetSession).Methods("GET")
	api.HandleFunc("/sessions/{session}", engine.handleDeleteSession).Methods("DELETE")
	api.HandleFunc("/sessions/{session}/start", engine.handleStartSession).Methods("POST")
	api.HandleFunc("/sessions/{session}/stop", engine.handleStopSession).Methods("POST")
	api.HandleFunc("/sessions/{session}/logout", engine.handleLogoutSession).Methods("POST")
	api.HandleFunc("/sessions/{session}/restart", engine.handleRestartSession).Methods("POST")

	api.HandleFunc("/sendText", engine.handleSendText).Methods("POST")
	api.HandleFunc("/sendImage", engine.handleSendImage).Methods("POST")
	api.HandleFunc("/sendFile", engine.handleSendFile).Methods("POST")
	api.HandleFunc("/sendButtons", engine.handleSendButtons).Methods("POST")
	api.HandleFunc("/sendList", engine.handleSendList).Methods("POST")
	api.HandleFunc("/sendLocation", engine.handleSendLocation).Methods("POST")
	api.HandleFunc("/sendContactVcard", engine.handleSendContactVcard).Methods("POST")
	api.HandleFunc("/sendSeen", engine.handleSendSeen).Methods("POST")
	api.HandleFunc("/startTyping", engine.handleStartTyping).Methods("POST")
	api.HandleFunc("/stopTyping", engine.handleStopTyping).Methods("POST")

	api.HandleFunc("/{session}/new-message-id", engine.handleNewMessageID).Methods("GET")

	fmt.Println("WooAPI Engine v2 running on :3002")

	srv := &http.Server{
		Addr:    ":3002",
		Handler: r,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil {
			fmt.Println(err)
		}
	}()

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
	srv.Shutdown(context.Background())
}

func (e *Engine) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !e.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "ok",
		"version": "2.0.0",
		"engine":  "wooapi-engine-v2",
	})
}
