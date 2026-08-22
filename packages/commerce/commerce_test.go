package commerce

import (
	"errors"
	"testing"
)

func ctx(tenant string) TenantContext {
	return TenantContext{SchemaVersion: "1.0", TenantID: tenant, ActorID: "actor_1", ActorType: "user",
		Roles: []string{"tenant_admin"}, Scopes: []string{"product:read", "product:write"}, TraceID: "1234567890abcdef1234567890abcdef",
		RequestOrigin: RequestOrigin{Kind: "merchant_console", RequestID: "req_1"}}
}
func mustService(t *testing.T) *CommerceService {
	t.Helper()
	s, e := NewCommerceService(NewInMemoryCommerceStore())
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func input(sku string) ProductInput {
	return ProductInput{Name: "Widget", SKU: sku, Price: "12.50", Currency: "USD", Image: "img", Description: "desc"}
}
func assertCode(t *testing.T, e error, code string) {
	t.Helper()
	var ce *CommerceError
	if !errors.As(e, &ce) || ce.Code != code {
		t.Fatalf("got %v, want %s", e, code)
	}
}

func TestCRUDAndTenantIsolation(t *testing.T) {
	s := mustService(t)
	c := ctx("tenant_a")
	cat, e := s.CreateCategory(c, " Toys ")
	if e != nil {
		t.Fatal(e)
	}
	p, e := s.CreateProduct(c, ProductInput{Name: "Ball", SKU: "B-1", Price: 10, Currency: "USD", CategoryID: cat.ID})
	if e != nil {
		t.Fatal(e)
	}
	if p.PriceMinor != 1000 || p.Name != "Ball" || p.CanonicalID == "" {
		t.Fatalf("bad product %#v", p)
	}
	if _, e = s.GetProduct(ctx("tenant_b"), p.ID); e == nil {
		t.Fatal("cross tenant access succeeded")
	} else {
		assertCode(t, e, "COMMERCE_NOT_FOUND")
	}
	if _, e = s.UpdateProduct(c, p.ID, ProductInput{Name: "New Ball"}); e != nil {
		t.Fatal(e)
	}
}

func TestImportPartialReplayAndConflict(t *testing.T) {
	s := mustService(t)
	c := ctx("tenant_a")
	r, e := s.ImportProducts(c, ImportRequest{IdempotencyKey: "import-key-000001", Rows: []ProductImportRow{input("A"), {Name: "", SKU: "B", Price: "bad", Currency: "USD"}, {Name: "Two", SKU: "A", Price: "2", Currency: "USD"}}})
	if e != nil {
		t.Fatal(e)
	}
	if r.SuccessCount != 1 || r.FailureCount != 2 || r.Imported != 1 || len(r.Errors) != 2 {
		t.Fatalf("unexpected result %#v", r)
	}
	replay, e := s.ImportProducts(c, ImportRequest{IdempotencyKey: "import-key-000001", Rows: []ProductImportRow{input("A"), {Name: "", SKU: "B", Price: "bad", Currency: "USD"}, {Name: "Two", SKU: "A", Price: "2", Currency: "USD"}}})
	if e != nil || replay.SuccessCount != 1 {
		t.Fatalf("replay %v %#v", e, replay)
	}
	_, e = s.ImportProducts(c, ImportRequest{IdempotencyKey: "import-key-000001", Rows: []ProductImportRow{input("Z")}})
	assertCode(t, e, "COMMERCE_CONFLICT")
}

func TestValidationAndDuplicateSKU(t *testing.T) {
	s := mustService(t)
	c := ctx("tenant_a")
	if _, e := s.CreateProduct(c, input("X")); e != nil {
		t.Fatal(e)
	}
	if _, e := s.CreateProduct(c, input("X")); e == nil {
		t.Fatal("duplicate accepted")
	} else {
		assertCode(t, e, "COMMERCE_DUPLICATE_SKU")
	}
	bad := ctx("tenant_a")
	bad.TraceID = "not-valid"
	if _, e := s.ListProducts(bad); e == nil {
		t.Fatal("invalid context accepted")
	}
	_, e := s.ImportProducts(c, ImportRequest{IdempotencyKey: "long-enough-key-1", Rows: []ProductImportRow{{Name: "x", SKU: "x", Price: "1.001", Currency: "USD"}}})
	if e != nil {
		t.Fatal(e)
	}
}
