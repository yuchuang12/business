package commerce

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

type TenantContext struct {
	SchemaVersion string
	TenantID      string
	ActorID       string
	ActorType     string
	Roles         []string
	Scopes        []string
	TraceID       string
	RequestOrigin RequestOrigin
}
type RequestOrigin struct{ Kind, RequestID string }

var idRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$`)
var traceRE = regexp.MustCompile(`^[0-9a-f]{32}$`)

func (c TenantContext) Validate() error {
	if c.SchemaVersion != "1.0" || !idRE.MatchString(c.TenantID) || !idRE.MatchString(c.ActorID) ||
		!traceRE.MatchString(c.TraceID) || c.TraceID == strings.Repeat("0", 32) || len(c.Roles) == 0 || len(c.Scopes) == 0 ||
		!idRE.MatchString(c.RequestOrigin.RequestID) {
		return NewError("COMMERCE_INVALID_REQUEST", "A valid TenantContext v1 is required.")
	}
	actors := map[string]bool{"user": true, "customer_session": true, "service_principal": true}
	origins := map[string]bool{"merchant_console": true, "customer_site": true, "public_api": true, "webhook": true, "scheduled_job": true, "internal_worker": true}
	if !actors[c.ActorType] || !origins[c.RequestOrigin.Kind] || duplicate(c.Roles) || duplicate(c.Scopes) {
		return NewError("COMMERCE_INVALID_REQUEST", "A valid TenantContext v1 is required.")
	}
	roles := map[string]bool{"tenant_owner": true, "tenant_admin": true, "merchant_operator": true, "support_readonly": true, "customer": true, "system_service": true}
	scopes := map[string]bool{"tenant:read": true, "tenant:write": true, "site:read": true, "site:write": true, "site:publish": true, "product:read": true, "product:write": true, "asset:read": true, "asset:write": true, "commerce:read": true, "commerce:write": true, "cart:write": true, "order:write": true}
	for _, r := range c.Roles {
		if !roles[r] {
			return NewError("COMMERCE_INVALID_REQUEST", "A valid TenantContext v1 is required.")
		}
	}
	for _, scope := range c.Scopes {
		if !scopes[scope] {
			return NewError("COMMERCE_INVALID_REQUEST", "A valid TenantContext v1 is required.")
		}
	}
	if c.ActorType == "user" && (c.RequestOrigin.Kind != "merchant_console" && c.RequestOrigin.Kind != "customer_site" && c.RequestOrigin.Kind != "public_api") {
		return NewError("COMMERCE_INVALID_REQUEST", "A valid TenantContext v1 is required.")
	}
	if c.ActorType == "customer_session" && !(len(c.Roles) == 1 && c.Roles[0] == "customer" && c.RequestOrigin.Kind == "customer_site") ||
		c.ActorType == "service_principal" && !(len(c.Roles) == 1 && c.Roles[0] == "system_service" && origins[c.RequestOrigin.Kind] && c.RequestOrigin.Kind != "merchant_console" && c.RequestOrigin.Kind != "customer_site" && c.RequestOrigin.Kind != "public_api") {
		return NewError("COMMERCE_INVALID_REQUEST", "A valid TenantContext v1 is required.")
	}
	for _, s := range c.Scopes {
		if !strings.Contains(s, ":") {
			return NewError("COMMERCE_INVALID_REQUEST", "A valid TenantContext v1 is required.")
		}
	}
	return nil
}
func duplicate(v []string) bool {
	m := map[string]bool{}
	for _, x := range v {
		if m[x] {
			return true
		}
		m[x] = true
	}
	return false
}

type CommerceError struct {
	Code, Category, Message string
	Retryable               bool
}

func (e *CommerceError) Error() string { return e.Code + ": " + e.Message }
func NewError(code, message string) *CommerceError {
	cat := map[string]string{"COMMERCE_INVALID_REQUEST": "validation", "COMMERCE_FORBIDDEN": "authorization", "COMMERCE_NOT_FOUND": "not_found", "COMMERCE_CONFLICT": "conflict", "COMMERCE_DUPLICATE_SKU": "conflict"}
	return &CommerceError{Code: code, Category: cat[code], Message: message}
}

type Category struct {
	ID, CanonicalID, TenantID, Name string
	CreatedAt, UpdatedAt            time.Time
}
type Product struct {
	ID, CanonicalID, TenantID, Name, SKU, Currency, Image, Description, CategoryID string
	PriceMinor                                                                     int64
	CreatedAt, UpdatedAt                                                           time.Time
}
type ProductInput struct {
	Name, SKU, Currency, Image, Description, CategoryID string
	Price                                               any
	PriceMinor                                          *int64
}
type ProductImportRow = ProductInput
type ImportRequest struct {
	Rows           []ProductImportRow
	IdempotencyKey string
}
type RowError struct {
	Row                     int
	Code, Category, Message string
}
type ImportProduct struct {
	Row     int
	Product Product
}
type ImportResult struct {
	Imported, Updated, Failed, Total, SuccessCount, FailureCount int
	Errors                                                       []RowError
	Products                                                     []ImportProduct
}
type AuditRecord struct {
	TenantID, ActorID, TraceID, Action, TargetID, Outcome string
	At                                                    time.Time
}

type InMemoryCommerceStore struct {
	mu          sync.RWMutex
	products    map[string]Product
	categories  map[string]Category
	idempotency map[string]storedImport
	Audit       []AuditRecord
	next        uint64
}
type storedImport struct {
	Hash   string
	Result ImportResult
}

func NewInMemoryCommerceStore() *InMemoryCommerceStore {
	return &InMemoryCommerceStore{products: map[string]Product{}, categories: map[string]Category{}, idempotency: map[string]storedImport{}}
}

type CommerceService struct{ store *InMemoryCommerceStore }

func NewCommerceService(store *InMemoryCommerceStore) (*CommerceService, error) {
	if store == nil {
		return nil, NewError("COMMERCE_INVALID_REQUEST", "A commerce store is required.")
	}
	return &CommerceService{store: store}, nil
}
func (s *CommerceService) valid(c TenantContext, scope string) error {
	if err := c.Validate(); err != nil {
		return err
	}
	for _, x := range c.Scopes {
		if x == scope || x == "commerce:"+strings.TrimPrefix(scope, "product:") || x == "commerce:read" && scope == "product:read" || x == "commerce:write" && scope == "product:write" {
			return nil
		}
	}
	return NewError("COMMERCE_FORBIDDEN", "The actor is not authorized for this commerce operation.")
}
func (s *CommerceService) id(prefix string) string {
	s.store.next++
	return fmt.Sprintf("%s_%d", prefix, s.store.next)
}
func (s *CommerceService) audit(c TenantContext, action, target, outcome string) {
	s.store.Audit = append(s.store.Audit, AuditRecord{c.TenantID, c.ActorID, c.TraceID, action, target, outcome, time.Now()})
}

func (s *CommerceService) CreateCategory(c TenantContext, name string) (Category, error) {
	if err := s.valid(c, "product:write"); err != nil {
		return Category{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return Category{}, NewError("COMMERCE_INVALID_REQUEST", "Category name is required.")
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	now := time.Now()
	id := s.id("category")
	v := Category{id, id, c.TenantID, name, now, now}
	s.store.categories[id] = v
	s.audit(c, "category.create", id, "accepted")
	return v, nil
}
func (s *CommerceService) GetCategory(c TenantContext, id string) (Category, error) {
	if err := s.valid(c, "product:read"); err != nil {
		return Category{}, err
	}
	s.store.mu.RLock()
	defer s.store.mu.RUnlock()
	v, ok := s.store.categories[id]
	if !ok || v.TenantID != c.TenantID {
		return Category{}, NewError("COMMERCE_NOT_FOUND", "Resource is not visible.")
	}
	return v, nil
}
func (s *CommerceService) UpdateCategory(c TenantContext, id, name string) (Category, error) {
	if err := s.valid(c, "product:write"); err != nil {
		return Category{}, err
	}
	if strings.TrimSpace(name) == "" {
		return Category{}, NewError("COMMERCE_INVALID_REQUEST", "Category name is required.")
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	v, ok := s.store.categories[id]
	if !ok || v.TenantID != c.TenantID {
		return Category{}, NewError("COMMERCE_NOT_FOUND", "Resource is not visible.")
	}
	v.Name = strings.TrimSpace(name)
	v.UpdatedAt = time.Now()
	s.store.categories[id] = v
	s.audit(c, "category.update", id, "accepted")
	return v, nil
}
func (s *CommerceService) ListCategories(c TenantContext) ([]Category, error) {
	if err := s.valid(c, "product:read"); err != nil {
		return nil, err
	}
	s.store.mu.RLock()
	defer s.store.mu.RUnlock()
	r := []Category{}
	for _, v := range s.store.categories {
		if v.TenantID == c.TenantID {
			r = append(r, v)
		}
	}
	return r, nil
}

func normalize(in ProductInput, requireSKU bool) (Product, error) {
	name, sku := strings.TrimSpace(in.Name), strings.TrimSpace(in.SKU)
	if name == "" || (requireSKU && sku == "") {
		return Product{}, NewError("COMMERCE_INVALID_REQUEST", "Product name and SKU are required.")
	}
	cur := in.Currency
	if cur == "" {
		cur = "USD"
	}
	if len(cur) != 3 || cur != strings.ToUpper(cur) {
		return Product{}, NewError("COMMERCE_INVALID_REQUEST", "Currency must be an uppercase ISO 4217 code.")
	}
	minor, err := price(in.Price, in.PriceMinor, cur)
	if err != nil {
		return Product{}, err
	}
	return Product{Name: name, SKU: sku, Currency: cur, PriceMinor: minor, Image: in.Image, Description: in.Description, CategoryID: in.CategoryID}, nil
}
func price(v any, p *int64, cur string) (int64, error) {
	if p != nil {
		if *p < 0 {
			return 0, NewError("COMMERCE_INVALID_REQUEST", "price_minor must be a non-negative integer.")
		}
		return *p, nil
	}
	if v == nil {
		return 0, NewError("COMMERCE_INVALID_REQUEST", "Price format is invalid.")
	}
	z := strings.TrimSpace(fmt.Sprint(v))
	digits := 2
	for _, x := range []string{"JPY", "KRW", "VND", "CLP", "BIF", "XOF", "XAF"} {
		if cur == x {
			digits = 0
		}
	}
	re := regexp.MustCompile(`^\d+(?:\.\d{1,2})?$`)
	if digits == 0 {
		re = regexp.MustCompile(`^\d+$`)
	}
	if !re.MatchString(z) {
		return 0, NewError("COMMERCE_INVALID_REQUEST", "Price format is invalid.")
	}
	var whole, frac int64
	fmt.Sscanf(z, "%d", &whole)
	if i := strings.IndexByte(z, '.'); i >= 0 {
		fmt.Sscanf(z[i+1:], "%d", &frac)
		if digits == 2 && len(z)-i-1 == 1 {
			frac *= 10
		}
	}
	mult := int64(1)
	for i := 0; i < digits; i++ {
		mult *= 10
	}
	return whole*mult + frac, nil
}

func (s *CommerceService) CreateProduct(c TenantContext, in ProductInput) (Product, error) {
	if err := s.valid(c, "product:write"); err != nil {
		return Product{}, err
	}
	v, err := normalize(in, false)
	if err != nil {
		return Product{}, err
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	if v.CategoryID != "" {
		x, ok := s.store.categories[v.CategoryID]
		if !ok || x.TenantID != c.TenantID {
			return Product{}, NewError("COMMERCE_NOT_FOUND", "Resource is not visible.")
		}
	}
	for _, x := range s.store.products {
		if x.TenantID == c.TenantID && v.SKU != "" && x.SKU == v.SKU {
			return Product{}, NewError("COMMERCE_DUPLICATE_SKU", "SKU is already used by another product.")
		}
	}
	now := time.Now()
	v.ID = s.id("product")
	v.CanonicalID = v.ID
	v.TenantID = c.TenantID
	v.CreatedAt = now
	v.UpdatedAt = now
	s.store.products[v.ID] = v
	s.audit(c, "product.create", v.ID, "accepted")
	return v, nil
}
func (s *CommerceService) GetProduct(c TenantContext, id string) (Product, error) {
	if err := s.valid(c, "product:read"); err != nil {
		return Product{}, err
	}
	s.store.mu.RLock()
	defer s.store.mu.RUnlock()
	v, ok := s.store.products[id]
	if !ok || v.TenantID != c.TenantID {
		return Product{}, NewError("COMMERCE_NOT_FOUND", "Resource is not visible.")
	}
	return v, nil
}
func (s *CommerceService) UpdateProduct(c TenantContext, id string, in ProductInput) (Product, error) {
	if err := s.valid(c, "product:write"); err != nil {
		return Product{}, err
	}
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	old, ok := s.store.products[id]
	if !ok || old.TenantID != c.TenantID {
		return Product{}, NewError("COMMERCE_NOT_FOUND", "Resource is not visible.")
	}
	if in.Currency == "" {
		in.Currency = old.Currency
	}
	if in.Name == "" {
		in.Name = old.Name
	}
	if in.SKU == "" {
		in.SKU = old.SKU
	}
	if in.Price == nil && in.PriceMinor == nil {
		p := old.PriceMinor
		in.PriceMinor = &p
	}
	v, err := normalize(in, false)
	if err != nil {
		return Product{}, err
	}
	for k, x := range s.store.products {
		if k != id && x.TenantID == c.TenantID && v.SKU != "" && x.SKU == v.SKU {
			return Product{}, NewError("COMMERCE_DUPLICATE_SKU", "SKU is already used by another product.")
		}
	}
	v.ID, v.CanonicalID, v.TenantID, v.CreatedAt = id, old.CanonicalID, old.TenantID, old.CreatedAt
	v.UpdatedAt = time.Now()
	s.store.products[id] = v
	s.audit(c, "product.update", id, "accepted")
	return v, nil
}
func (s *CommerceService) ListProducts(c TenantContext) ([]Product, error) {
	if err := s.valid(c, "product:read"); err != nil {
		return nil, err
	}
	s.store.mu.RLock()
	defer s.store.mu.RUnlock()
	r := []Product{}
	for _, v := range s.store.products {
		if v.TenantID == c.TenantID {
			r = append(r, v)
		}
	}
	return r, nil
}

func (s *CommerceService) ImportProducts(c TenantContext, req ImportRequest) (ImportResult, error) {
	if err := s.valid(c, "product:write"); err != nil {
		return ImportResult{}, err
	}
	if len(req.Rows) == 0 || len(req.Rows) > 1000 || len(req.IdempotencyKey) < 16 {
		return ImportResult{}, NewError("COMMERCE_INVALID_REQUEST", "Import rows and an idempotency key are required.")
	}
	b, _ := json.Marshal(req.Rows)
	h := fmt.Sprintf("%x", sha256.Sum256(b))
	scope := c.TenantID + ":" + req.IdempotencyKey
	s.store.mu.Lock()
	defer s.store.mu.Unlock()
	if p, ok := s.store.idempotency[scope]; ok {
		if p.Hash != h {
			return ImportResult{}, NewError("COMMERCE_CONFLICT", "Idempotency key was already used with different input.")
		}
		return p.Result, nil
	}
	r := ImportResult{Total: len(req.Rows)}
	seen := map[string]bool{}
	for i, row := range req.Rows {
		v, err := normalize(row, true)
		if err == nil && seen[v.SKU] {
			err = NewError("COMMERCE_DUPLICATE_SKU", "SKU is duplicated in the import.")
		}
		if err == nil {
			seen[v.SKU] = true
			if v.CategoryID != "" {
				x, ok := s.store.categories[v.CategoryID]
				if !ok || x.TenantID != c.TenantID {
					err = NewError("COMMERCE_NOT_FOUND", "Resource is not visible.")
				}
			}
		}
		if err != nil {
			r.Failed++
			r.FailureCount++
			e := err.(*CommerceError)
			r.Errors = append(r.Errors, RowError{i + 1, e.Code, e.Category, e.Message})
			continue
		}
		var oldID string
		for id, x := range s.store.products {
			if x.TenantID == c.TenantID && x.SKU == v.SKU {
				oldID = id
				break
			}
		}
		now := time.Now()
		if oldID != "" {
			old := s.store.products[oldID]
			v.ID, v.CanonicalID, v.TenantID, v.CreatedAt = oldID, old.CanonicalID, c.TenantID, old.CreatedAt
			r.Updated++
		} else {
			v.ID = s.id("product")
			v.CanonicalID = v.ID
			v.TenantID = c.TenantID
			v.CreatedAt = now
			r.Imported++
		}
		v.UpdatedAt = now
		s.store.products[v.ID] = v
		r.SuccessCount++
		r.Products = append(r.Products, ImportProduct{i + 1, v})
	}
	s.store.idempotency[scope] = storedImport{h, r}
	out := "accepted"
	if r.Failed > 0 {
		out = "partial"
	}
	s.audit(c, "product.import", "", out)
	return r, nil
}
