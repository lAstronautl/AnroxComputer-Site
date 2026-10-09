# frozen_string_literal: true

# Let Markdown files in `_posts` work without a `YYYY-MM-DD-` filename
# prefix and without a front-matter `date`. Posts are ordered by their
# own `number` field instead (see sort-posts-by-number.rb).
module Jekyll
  class PostReader
    def read_posts(dir)
      read_content(dir, "_posts", Document::DATELESS_FILENAME_MATCHER)
        .tap { |docs| docs.each(&:read) }
        .select { |doc| processable?(doc) && doc.extname != ".canvas" }
    end
  end
end
